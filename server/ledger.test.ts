import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_TERMS } from '../shared/types';
import { Ledger, LedgerError, freezeTerms, type ChainProof } from './ledger';

// Uses LEDGER_TEST_DATABASE_URL, or boots a throwaway local PostgreSQL cluster.
function findPgBin(): string | null {
  const dirs = ['17', '16', '15', '14'].map(v => `/opt/homebrew/opt/postgresql@${v}/bin`)
    .concat(['/usr/lib/postgresql/17/bin', '/usr/local/bin', '/usr/bin']);
  return dirs.find(dir => existsSync(join(dir, 'pg_ctl')) && existsSync(join(dir, 'initdb'))) ?? null;
}

const external = process.env.LEDGER_TEST_DATABASE_URL;
const pgBin = external ? null : findPgBin();
const available = !!external || !!pgBin;
let dataDir = '';
let url = external ?? '';
let ledger: Ledger;

const wallet = () => `0x${crypto.randomUUID().replaceAll('-', '').padEnd(40, 'a')}`;
const hash = () => `0x${crypto.randomUUID().replaceAll('-', '').repeat(2)}`;
const chainProof = (): ChainProof => ({
  chainId: 8453, txHash: hash(), blockNumber: 123, confirmations: 2, verifiedAt: new Date().toISOString(),
});
const code = (promise: Promise<unknown>) => promise.then(() => 'ok', (e: unknown) =>
  e instanceof LedgerError ? e.code : `unexpected: ${String(e)}`);

async function activePass(terms = DEFAULT_TERMS) {
  const pass = await ledger.requestPass(wallet(), 'alice', terms, 'req-1');
  await ledger.acceptPass(pass.id, chainProof());
  return ledger.activatePass(pass.id, chainProof());
}

beforeAll(async () => {
  if (!available) return;
  if (pgBin) {
    dataDir = mkdtempSync(join(tmpdir(), 'swipr-ledger-'));
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    execFileSync(join(pgBin, 'initdb'), ['-D', join(dataDir, 'db'), '-U', 'ledger', '--auth=trust'], { stdio: 'ignore' });
    execFileSync(join(pgBin, 'pg_ctl'), ['-D', join(dataDir, 'db'), '-w', '-l', join(dataDir, 'log'),
      '-o', `-p ${port} -k ${dataDir} -c listen_addresses=127.0.0.1`, 'start'], { stdio: 'ignore' });
    url = `postgres://ledger@127.0.0.1:${port}/postgres`;
  }
  ledger = await Ledger.open(url);
}, 60_000);

afterAll(async () => {
  await ledger?.close();
  if (pgBin && dataDir) {
    execFileSync(join(pgBin, 'pg_ctl'), ['-D', join(dataDir, 'db'), '-m', 'fast', 'stop'], { stdio: 'ignore' });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

describe('freezeTerms', () => {
  it('rejects fractional money and out-of-range terms', () => {
    expect(() => freezeTerms({ ...DEFAULT_TERMS, perTradeUsd: 10.5 })).toThrow(LedgerError);
    expect(() => freezeTerms({ ...DEFAULT_TERMS, tradeCount: 21 })).toThrow(LedgerError);
    expect(() => freezeTerms({ ...DEFAULT_TERMS, profitShareBps: 1_001 })).toThrow(LedgerError);
    expect(freezeTerms({ ...DEFAULT_TERMS, extra: 1 } as never)).not.toHaveProperty('extra');
  });
});

describe.skipIf(!available)('ledger on PostgreSQL', () => {
  it('reports health and freezes terms idempotently', async () => {
    expect(await ledger.health()).toEqual({ ok: true, schemaVersion: 1 });
    const owner = wallet();
    const first = await ledger.requestPass(owner, 'alice', DEFAULT_TERMS, 'k');
    const again = await ledger.requestPass(owner.toUpperCase().replace('0X', '0x'), 'alice', DEFAULT_TERMS, 'k');
    expect(again.id).toBe(first.id);
    expect(first).toMatchObject({ status: 'requested', capMicros: '50000000', perTradeMicros: '10000000' });
    expect(await code(ledger.requestPass(owner, 'alice', { ...DEFAULT_TERMS, tradeCount: 6 }, 'k'))).toBe('conflict');
    expect(await code(ledger.reserveEntry(first.id, 's', '1', 'r'))).toBe('state');
    expect(await ledger.listPasses(owner)).toHaveLength(1);
  });

  it('requires ordered, unique chain proofs before activation', async () => {
    const pass = await ledger.requestPass(wallet(), 'dan', DEFAULT_TERMS, 'k');
    expect(await code(ledger.activatePass(pass.id, chainProof()))).toBe('state');
    expect(await code(ledger.acceptPass(pass.id, { ...chainProof(), confirmations: 0 }))).toBe('invalid');
    const accept = chainProof();
    await ledger.acceptPass(pass.id, accept);
    expect((await ledger.acceptPass(pass.id, accept)).status).toBe('accepted'); // replay is a no-op
    const other = await ledger.requestPass(wallet(), 'dan', DEFAULT_TERMS, 'k');
    expect(await code(ledger.acceptPass(other.id, accept))).toBe('conflict');
    const active = await ledger.activatePass(pass.id, chainProof());
    expect(active.status).toBe('active');
    expect(Date.parse(active.expiresAt!) - Date.parse(active.activatedAt!)).toBe(7 * 86_400_000);
  });

  it('enforces cumulative cap and count atomically under concurrency', async () => {
    const pass = await activePass();
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      code(ledger.reserveEntry(pass.id, `sig-${i}`, '10000000', `key-${i}`))));
    expect(results.filter(r => r === 'ok')).toHaveLength(5);
    expect(results.filter(r => r !== 'ok').every(r => r === 'count_exceeded' || r === 'cap_exceeded')).toBe(true);
    expect(await ledger.getPass(pass.id)).toMatchObject({ heldMicros: '50000000', entries: 5, availableMicros: '0' });
  });

  it('deduplicates reservations by key and signal', async () => {
    const pass = await activePass();
    const first = await ledger.reserveEntry(pass.id, 'sig', '4000000', 'key');
    expect((await ledger.reserveEntry(pass.id, 'sig', 4_000_000n, 'key')).id).toBe(first.id);
    expect(await code(ledger.reserveEntry(pass.id, 'sig', '5000000', 'key'))).toBe('conflict');
    expect(await code(ledger.reserveEntry(pass.id, 'sig', '4000000', 'key-2'))).toBe('conflict');
    expect(await code(ledger.reserveEntry(pass.id, 'big', '10000001', 'key-3'))).toBe('cap_exceeded');
    expect(await code(ledger.reserveEntry(pass.id, 'x', '1.5', 'key-4'))).toBe('invalid');
    expect((await ledger.getPass(pass.id)).entries).toBe(1);
  });

  it('holds ambiguous fills and releases only reconciled remainder', async () => {
    const pass = await activePass({ ...DEFAULT_TERMS, tradeCount: 2 });
    const a = await ledger.reserveEntry(pass.id, 'a', '10000000', 'a');
    const b = await ledger.reserveEntry(pass.id, 'b', '10000000', 'b');
    await ledger.reconcileEntry(a.id, '4000000', '1000', false, { tx: 'partial' });
    expect(await ledger.getPass(pass.id)).toMatchObject({ spentMicros: '4000000', heldMicros: '16000000' });
    expect(await code(ledger.reconcileEntry(a.id, '3000000', '1000', false, { tx: 'x' }))).toBe('invalid');
    await ledger.reconcileEntry(a.id, '6000000', '1500', true, { tx: 'final' });
    expect(await ledger.reconcileEntry(a.id, '6000000', '1500', true, { tx: 'final' })).toMatchObject({ status: 'settled' });
    expect(await code(ledger.reconcileEntry(a.id, '7000000', '1500', true, { tx: 'late' }))).toBe('state');
    await ledger.reconcileEntry(b.id, '0', '0', true, { reason: 'rejected' });
    expect(await ledger.getPass(pass.id)).toMatchObject({
      spentMicros: '6000000', heldMicros: '0', availableMicros: '14000000', entries: 1,
    });
    const kinds = (await ledger.events(pass.id)).map(e => e.kind);
    expect(kinds.filter(k => k === 'entry_settled')).toHaveLength(2);
  });

  it('keeps events immutable and state durable across restart', async () => {
    const pass = await activePass();
    await ledger.reserveEntry(pass.id, 's', '10000000', 'k');
    await ledger.close();
    ledger = await Ledger.open(url);
    expect(await ledger.getPass(pass.id)).toMatchObject({ status: 'active', heldMicros: '10000000' });
    expect((await ledger.reserveEntry(pass.id, 's', '10000000', 'k')).signalId).toBe('s');
    const { default: pg } = await import('pg');
    const raw = new pg.Client({ connectionString: url });
    await raw.connect();
    await expect(raw.query('DELETE FROM ledger_events WHERE pass_id = $1', [pass.id])).rejects.toThrow(/append-only/);
    await raw.end();
  });

  it('leases, retries, reclaims and dead-letters jobs', async () => {
    const kind = `job-${crypto.randomUUID()}`;
    const job = await ledger.enqueueJob(kind, { n: 1 }, { dedupeKey: `${kind}-d`, maxAttempts: 2 });
    expect((await ledger.enqueueJob(kind, { n: 2 }, { dedupeKey: `${kind}-d` })).id).toBe(job.id);
    const first = (await ledger.claimJob([kind], 60_000))!;
    expect(await ledger.claimJob([kind], 60_000)).toBeNull();
    expect((await ledger.failJob(first.id, first.leaseToken!, 'boom', 0)).status).toBe('queued');
    const second = (await ledger.claimJob([kind], 1))!;
    expect(second.attempts).toBe(2);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(await ledger.claimJob([kind], 60_000)).toBeNull(); // lease expired at max attempts
    expect(await code(ledger.completeJob(second.id, second.leaseToken!))).toBe('lease_lost');
    const other = await ledger.enqueueJob(kind, {}, { maxAttempts: 3 });
    const stale = (await ledger.claimJob([kind], 1))!;
    await new Promise(resolve => setTimeout(resolve, 20));
    const reclaimed = (await ledger.claimJob([kind], 60_000))!;
    expect(reclaimed.id).toBe(other.id);
    expect(await code(ledger.completeJob(stale.id, stale.leaseToken!))).toBe('lease_lost');
    await ledger.completeJob(reclaimed.id, reclaimed.leaseToken!);
    expect(await ledger.claimJob([kind], 60_000)).toBeNull();
  });
});
