import { describe, expect, it } from 'vitest';
import { DEFAULT_TERMS } from '../shared/types';
import type { Journal, JournalEvent } from './arkiv-journal';
import { Ledger, LedgerError, freezeTerms, type ChainProof } from './ledger';

/**
 * Test-only in-memory journal with an atomic compare-nonce append. It models the
 * host's Arkiv contract; nothing here is verified against a real chain.
 */
class MemoryJournal implements Journal {
  readonly canWrite = true;
  events: JournalEvent[] = [];
  clock = Date.parse('2026-11-06T00:00:00Z');
  block = 100n;
  loseNextAck = false;
  private tick = () => new Promise(resolve => setImmediate(resolve));
  async read() {
    await this.tick();
    return { events: structuredClone(this.events), nonce: this.events.length, blockNumber: this.block, timestampMs: this.clock };
  }
  async append(event: JournalEvent, expectedNonce: number) {
    await this.tick();
    if (expectedNonce !== this.events.length || event.revision !== expectedNonce + 1) throw new Error('nonce too low');
    this.events.push(structuredClone(event));
    this.block += 1n;
    if (this.loseNextAck) { this.loseNextAck = false; throw new Error('receipt timeout'); }
  }
  async close() {}
}

/** API-style replica: same confirmed events, no writer key. */
const readOnly = (journal: MemoryJournal): Journal => ({
  canWrite: false, read: () => journal.read(), close: async () => {},
  append: () => Promise.reject(new Error('no writer key')),
});

const wallet = () => `0x${crypto.randomUUID().replaceAll('-', '').padEnd(40, 'a')}`;
const hash = () => `0x${crypto.randomUUID().replaceAll('-', '').repeat(2)}`;
const chainProof = (): ChainProof => ({ chainId: 8453, txHash: hash(), blockNumber: 123, confirmations: 2,
  verifiedAt: new Date().toISOString() });
const code = (promise: Promise<unknown>) => promise.then(() => 'ok', (e: unknown) =>
  e instanceof LedgerError ? e.code : `unexpected: ${String(e)}`);

const setup = async (journal = new MemoryJournal()) => ({ journal, ledger: await Ledger.open(journal) });

async function activePass(ledger: Ledger, terms = DEFAULT_TERMS) {
  const pass = await ledger.requestPass(wallet(), 'alice', terms, 'req-1');
  await ledger.acceptPass(pass.id, chainProof());
  return ledger.activatePass(pass.id, chainProof());
}

describe('freezeTerms', () => {
  it('rejects fractional money and out-of-range terms', () => {
    expect(() => freezeTerms({ ...DEFAULT_TERMS, perTradeUsd: 10.5 })).toThrow(LedgerError);
    expect(() => freezeTerms({ ...DEFAULT_TERMS, tradeCount: 21 })).toThrow(LedgerError);
    expect(() => freezeTerms({ ...DEFAULT_TERMS, profitShareBps: 1_001 })).toThrow(LedgerError);
    expect(freezeTerms({ ...DEFAULT_TERMS, extra: 1 } as never)).not.toHaveProperty('extra');
  });
});

describe('ledger over an in-memory journal test double', () => {
  it('reports health and freezes terms idempotently without duplicate appends', async () => {
    const { journal, ledger } = await setup();
    expect(await ledger.health()).toEqual({ ok: true, schemaVersion: 1, storage: 'arkiv', blockNumber: '100', canWrite: true });
    const owner = wallet();
    const first = await ledger.requestPass(owner, 'alice', DEFAULT_TERMS, 'k');
    const again = await ledger.requestPass(owner.toUpperCase().replace('0X', '0x'), 'alice', DEFAULT_TERMS, 'k');
    expect(again.id).toBe(first.id);
    expect(journal.events).toHaveLength(1);
    expect(first).toMatchObject({ status: 'requested', capMicros: '50000000', perTradeMicros: '10000000' });
    expect(await code(ledger.requestPass(owner, 'alice', { ...DEFAULT_TERMS, tradeCount: 6 }, 'k'))).toBe('conflict');
    expect(await code(ledger.reserveEntry(first.id, 's', '1', 'r'))).toBe('state');
    expect(await ledger.listPasses(owner)).toHaveLength(1);
    expect(journal.events).toHaveLength(1);
  });

  it('requires ordered, unique chain proofs and expires on chain time', async () => {
    const { journal, ledger } = await setup();
    const pass = await ledger.requestPass(wallet(), 'dan', DEFAULT_TERMS, 'k');
    expect(await code(ledger.activatePass(pass.id, chainProof()))).toBe('state');
    expect(await code(ledger.acceptPass(pass.id, { ...chainProof(), confirmations: 0 }))).toBe('invalid');
    const accept = chainProof();
    await ledger.acceptPass(pass.id, accept);
    expect((await ledger.acceptPass(pass.id, accept)).status).toBe('accepted'); // replay is a no-op
    const other = await ledger.requestPass(wallet(), 'dan', DEFAULT_TERMS, 'k');
    expect(await code(ledger.acceptPass(other.id, accept))).toBe('conflict');
    journal.clock += 5_000;
    const active = await ledger.activatePass(pass.id, chainProof());
    expect(active).toMatchObject({ status: 'active', activatedAt: new Date(journal.clock).toISOString() });
    expect(Date.parse(active.expiresAt!) - Date.parse(active.activatedAt!)).toBe(7 * 86_400_000);
    journal.clock += 7 * 86_400_000;
    expect(await code(ledger.reserveEntry(pass.id, 's', '1', 'r'))).toBe('expired');
  });

  it('fences two writers on one journal: stale writers fail and cannot overspend', async () => {
    const { journal, ledger: a } = await setup();
    const b = await Ledger.open({ canWrite: true, read: () => journal.read(), append: (e, n) => journal.append(e, n), close: async () => {} });
    const pass = await activePass(a);
    const reserve = (i: number) => (i % 2 ? a : b).reserveEntry(pass.id, `sig-${i}`, '10000000', `key-${i}`);
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => code(reserve(i))));
    const ok = results.filter(r => r === 'ok').length;
    expect(results).toContain('stale');
    expect(results.every(r => ['ok', 'stale', 'count_exceeded', 'cap_exceeded'].includes(r))).toBe(true);
    // Rejected writers did not recompute: only successful appends exist.
    expect((await a.events(pass.id)).filter(e => e.kind === 'entry_reserved')).toHaveLength(ok);
    expect(await b.getPass(pass.id)).toMatchObject({ entries: ok, heldMicros: String(ok * 10_000_000) });
    for (let i = 0; i < 12; i++) await code(reserve(i)); // explicit caller retries, same keys
    expect(await a.getPass(pass.id)).toMatchObject({ heldMicros: '50000000', entries: 5, availableMicros: '0' });
  });

  it('deduplicates reservations by key and signal', async () => {
    const { ledger } = await setup();
    const pass = await activePass(ledger);
    const first = await ledger.reserveEntry(pass.id, 'sig', '4000000', 'key');
    expect((await ledger.reserveEntry(pass.id, 'sig', 4_000_000n, 'key')).id).toBe(first.id);
    expect(await code(ledger.reserveEntry(pass.id, 'sig', '5000000', 'key'))).toBe('conflict');
    expect(await code(ledger.reserveEntry(pass.id, 'sig', '4000000', 'key-2'))).toBe('conflict');
    expect(await code(ledger.reserveEntry(pass.id, 'big', '10000001', 'key-3'))).toBe('cap_exceeded');
    expect(await code(ledger.reserveEntry(pass.id, 'x', '1.5', 'key-4'))).toBe('invalid');
    expect((await ledger.getPass(pass.id)).entries).toBe(1);
  });

  it('holds partial pending fills and releases only reconciled remainder', async () => {
    const { ledger } = await setup();
    const pass = await activePass(ledger, { ...DEFAULT_TERMS, tradeCount: 2 });
    const a = await ledger.reserveEntry(pass.id, 'a', '10000000', 'a');
    const b = await ledger.reserveEntry(pass.id, 'b', '10000000', 'b');
    await ledger.reconcileEntry(a.id, '4000000', '1000', false, { tx: 'partial' });
    expect(await ledger.getPass(pass.id)).toMatchObject({ spentMicros: '4000000', heldMicros: '16000000' });
    expect(await code(ledger.reconcileEntry(a.id, '3000000', '1000', false, { tx: 'x' }))).toBe('invalid');
    await ledger.reconcileEntry(a.id, '6000000', '1500', true, { tx: 'final' });
    expect(await ledger.reconcileEntry(a.id, '6000000', '1500', true, { tx: 'final' })).toMatchObject({ status: 'settled' });
    expect(await code(ledger.reconcileEntry(a.id, '7000000', '1500', true, { tx: 'late' }))).toBe('state');
    expect(await code(ledger.reconcileEntry(b.id, '0', '0', true, { signature: '0x1' }))).toBe('invalid');
    await ledger.reconcileEntry(b.id, '0', '0', true, { reason: 'rejected' });
    expect(await ledger.getPass(pass.id)).toMatchObject({
      spentMicros: '6000000', heldMicros: '0', availableMicros: '14000000', entries: 1,
    });
    const kinds = (await ledger.events(pass.id)).map(e => e.kind);
    expect(kinds.filter(k => k === 'entry_settled')).toHaveLength(2);
  });

  it('is idempotent when an acknowledgement is lost and the process restarts', async () => {
    const { journal, ledger } = await setup();
    const owner = wallet();
    journal.loseNextAck = true;
    expect(await code(ledger.requestPass(owner, 'alice', DEFAULT_TERMS, 'k'))).toBe('stale');
    const restarted = await Ledger.open(journal);
    const pass = await restarted.requestPass(owner, 'alice', DEFAULT_TERMS, 'k');
    expect(journal.events).toHaveLength(1);
    await restarted.acceptPass(pass.id, chainProof());
    await restarted.activatePass(pass.id, chainProof());
    journal.loseNextAck = true;
    expect(await code(restarted.reserveEntry(pass.id, 's', '10000000', 'r'))).toBe('stale');
    const again = await (await Ledger.open(journal)).reserveEntry(pass.id, 's', '10000000', 'r');
    expect(again.signalId).toBe('s');
    expect(await restarted.getPass(pass.id)).toMatchObject({ heldMicros: '10000000', entries: 1 });
    expect(journal.events).toHaveLength(4);
  });

  it('leases, retries, reclaims stale leases and dead-letters jobs on chain time', async () => {
    const { journal, ledger } = await setup();
    const job = await ledger.enqueueJob('probe', { n: 1 }, { dedupeKey: 'd', maxAttempts: 2 });
    expect((await ledger.enqueueJob('probe', { n: 2 }, { dedupeKey: 'd' })).id).toBe(job.id);
    const first = (await ledger.claimJob(['probe'], 60_000))!;
    expect(await ledger.claimJob(['probe'], 60_000)).toBeNull();
    expect((await ledger.failJob(first.id, first.leaseToken!, 'boom https://rpc.example/key', 0)))
      .toMatchObject({ status: 'queued', lastError: 'boom [url]' });
    const second = (await ledger.claimJob(['probe'], 1_000))!;
    expect(second.attempts).toBe(2);
    journal.clock += 2_000;
    expect(await ledger.claimJob(['probe'], 60_000)).toBeNull(); // lease expired at max attempts
    expect(await code(ledger.completeJob(second.id, second.leaseToken!))).toBe('lease_lost');
    const other = await ledger.enqueueJob('probe', {}, { maxAttempts: 3 });
    const stale = (await ledger.claimJob(['probe'], 1_000))!;
    journal.clock += 2_000;
    expect(await code(ledger.completeJob(stale.id, stale.leaseToken!))).toBe('lease_lost');
    expect(await code(ledger.failJob(stale.id, stale.leaseToken!, 'late'))).toBe('lease_lost');
    const reclaimed = (await ledger.claimJob(['probe'], 60_000))!;
    expect(reclaimed).toMatchObject({ id: other.id, attempts: 2 });
    expect(await code(ledger.completeJob(stale.id, stale.leaseToken!))).toBe('lease_lost');
    journal.loseNextAck = true;
    expect(await code(ledger.completeJob(reclaimed.id, reclaimed.leaseToken!))).toBe('stale');
    await ledger.completeJob(reclaimed.id, reclaimed.leaseToken!); // retry after lost ack
    expect(await ledger.claimJob(['probe'], 60_000)).toBeNull();
    expect(await code(ledger.enqueueJob('probe', { privateKey: '0xabc' }))).toBe('invalid');
  });

  it('serves a read-only replica and fails closed on an invalid journal', async () => {
    const { journal, ledger } = await setup();
    const pass = await activePass(ledger);
    const reader = await Ledger.open(readOnly(journal));
    expect(reader.canWrite).toBe(false);
    expect(await reader.getPass(pass.id)).toMatchObject({ status: 'active' });
    await ledger.reserveEntry(pass.id, 's', '1000000', 'r');
    expect((await reader.getPass(pass.id)).heldMicros).toBe('1000000'); // reads replay fresh
    expect(await code(reader.requestPass(wallet(), 'x', DEFAULT_TERMS, 'k'))).toBe('read_only');
    expect(await reader.health()).toMatchObject({ ok: true, canWrite: false, storage: 'arkiv' });
    journal.events.push({ revision: journal.events.length + 1, id: crypto.randomUUID(), at: journal.clock,
      command: { type: 'entry.reserve', reservationId: crypto.randomUUID(), passId: pass.id,
        signalId: 'evil', key: 'evil', amountMicros: '999000000' } });
    expect(await reader.health()).toMatchObject({ ok: false, blockNumber: '0' });
    await expect(Ledger.open(journal)).rejects.toThrow(/ledger_journal_invalid/);
  });
});
