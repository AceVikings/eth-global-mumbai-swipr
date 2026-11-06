import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { botMessage, type BotAction, type SignedBotAction } from '../contracts/bots';
import { ArkivJournal, JournalError, type ArkivPort, type Journal, type JournalEvent, type JournalSnapshot, type StoredEvent } from '../arkiv-journal';
import { ProjectStore, replayProject, validateProjectCommand } from './store';
import { BotError } from './validation';

const AUDIENCE = 'https://swipr.test';
const owner = privateKeyToAccount(`0x${'11'.repeat(32)}` as Hex);
const operator = privateKeyToAccount(`0x${'22'.repeat(32)}` as Hex);
const stranger = privateKeyToAccount(`0x${'33'.repeat(32)}` as Hex);
type Signer = typeof owner;

/** Contract double of the nonce-fenced Arkiv journal (runtime always uses Arkiv). */
class FakeJournal implements Journal {
  readonly canWrite = true;
  events: JournalEvent[] = [];
  nowMs = Date.now();
  appends = 0;
  /** When set, reads wait until this many readers arrive, forcing a genuine race. */
  barrier: { size: number; waiting: (() => void)[] } | null = null;
  async read(): Promise<JournalSnapshot> {
    if (this.barrier) {
      const b = this.barrier;
      await new Promise<void>(resolve => { b.waiting.push(resolve); if (b.waiting.length === b.size) b.waiting.forEach(r => r()); });
      this.barrier = null;
    }
    return structuredClone({ events: this.events, nonce: this.events.length, blockNumber: 1n, timestampMs: this.nowMs });
  }
  async append(event: JournalEvent, expectedNonce: number) {
    await Promise.resolve();
    if (expectedNonce !== this.events.length || event.revision !== expectedNonce + 1) throw new JournalError('conflict', 'Stale writer revision.');
    if (/signature/i.test(JSON.stringify(event))) throw new JournalError('invalid', 'signature stored');
    this.appends++;
    this.events.push(structuredClone(event));
  }
  async close() {}
}

const nowSec = (j: FakeJournal) => Math.floor(j.nowMs / 1000);
async function sign(signer: Signer, journal: FakeJournal, action: BotAction['action'], data: Record<string, unknown>,
  over: Partial<BotAction> = {}): Promise<SignedBotAction> {
  const payload: BotAction = { version: 1, audience: AUDIENCE, chainId: 8453, requestId: randomUUID(),
    issuedAt: nowSec(journal) - 5, expiresAt: nowSec(journal) + 120, action, data, ...over };
  return { payload, signature: await signer.signMessage({ message: botMessage(payload) }) };
}
const profileData = (extra: Record<string, unknown> = {}) => ({
  operator: operator.address, name: '  Momentum   Max ', bio: 'Trend follower on Base.', style: 'Balanced',
  strategy: 'rule-based', assets: ['cbBTC', 'WETH', 'WETH'], ...extra,
});
const signalData = (profileId: string, extra: Record<string, unknown> = {}) => ({
  profileId, asset: 'WETH', side: 'buy', quantity: '0.25', limitPrice: '3120.5', thesis: 'Breakout retest.', ...extra,
});
async function setup() {
  const journal = new FakeJournal();
  const store = new ProjectStore(journal, AUDIENCE);
  const created = await store.execute(await sign(owner, journal, 'profile.upsert', profileData()));
  return { journal, store, profile: created.profile! };
}

describe('ProjectStore registration', () => {
  it('creates a normalized profile owned by the recovered signer and stores no signature', async () => {
    const { journal, store, profile } = await setup();
    expect(profile).toMatchObject({ owner: owner.address.toLowerCase(), operator: operator.address.toLowerCase(),
      name: 'Momentum Max', style: 'Balanced', strategy: 'rule-based', assets: ['WETH', 'cbBTC'], status: 'active' });
    const command = journal.events[0].command as Record<string, unknown>;
    expect(command).toMatchObject({ type: 'project.bot', actor: owner.address.toLowerCase(), action: 'profile.upsert' });
    expect(profile.id).toBe(command.requestId);
    expect(JSON.stringify(journal.events)).not.toMatch(/signature|0x[0-9a-f]{130}/i);
    expect(await store.list()).toEqual({ profiles: [profile], signals: [] });
  });

  it('returns the prior result for an exact replay and rejects a changed payload under the same requestId', async () => {
    const journal = new FakeJournal(), store = new ProjectStore(journal, AUDIENCE);
    const envelope = await sign(owner, journal, 'profile.upsert', profileData());
    const first = await store.execute(envelope);
    const again = await new ProjectStore(journal, AUDIENCE).execute(structuredClone(envelope));
    expect(again).toEqual({ profile: first.profile, replayed: true });
    expect(journal.appends).toBe(1);
    const changed = await sign(owner, journal, 'profile.upsert', profileData({ name: 'Other' }), { requestId: envelope.payload.requestId });
    await expect(store.execute(changed)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('lets only the owner update or halt, keeps the id stable, and halted profiles reject signals', async () => {
    const { journal, store, profile } = await setup();
    const update = (signer: Signer) => sign(signer, journal, 'profile.upsert', profileData({ profileId: profile.id, name: 'Renamed' }));
    await expect(store.execute(await update(stranger))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(store.execute(await update(operator))).rejects.toMatchObject({ code: 'forbidden' });
    const updated = (await store.execute(await update(owner))).profile!;
    expect(updated).toMatchObject({ id: profile.id, name: 'Renamed', createdAt: profile.createdAt });
    await expect(store.execute(await sign(operator, journal, 'profile.halt', { profileId: profile.id }))).rejects.toMatchObject({ code: 'forbidden' });
    expect((await store.execute(await sign(owner, journal, 'profile.halt', { profileId: profile.id }))).profile!.status).toBe('halted');
    await expect(store.execute(await sign(operator, journal, 'signal.publish', signalData(profile.id)))).rejects.toMatchObject({ code: 'halted' });
    await expect(store.execute(await sign(owner, journal, 'profile.upsert', profileData({ profileId: profile.id })))).rejects.toMatchObject({ code: 'halted' });
  });

  it('caps profiles per owner and rejects unknown profile ids', async () => {
    const journal = new FakeJournal(), store = new ProjectStore(journal, AUDIENCE);
    for (let i = 0; i < 5; i++) await store.execute(await sign(owner, journal, 'profile.upsert', profileData()));
    await expect(store.execute(await sign(owner, journal, 'profile.upsert', profileData()))).rejects.toMatchObject({ code: 'limit' });
    await expect(store.execute(await sign(owner, journal, 'profile.upsert', profileData({ profileId: randomUUID() })))).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('ProjectStore signals', () => {
  it('lets the registered operator publish a proposal only for the profile assets', async () => {
    const { journal, store, profile } = await setup();
    const { signal, replayed } = await store.execute(await sign(operator, journal, 'signal.publish', signalData(profile.id)));
    expect(replayed).toBe(false);
    expect(signal).toMatchObject({ profileId: profile.id, operator: operator.address.toLowerCase(), asset: 'WETH',
      side: 'buy', quantity: '0.25', limitPrice: '3120.5', kind: 'proposal' });
    await expect(store.execute(await sign(owner, journal, 'signal.publish', signalData(profile.id)))).rejects.toMatchObject({ code: 'forbidden' });
    const narrow = (await store.execute(await sign(owner, journal, 'profile.upsert', profileData({ profileId: profile.id, assets: ['cbBTC'] })))).profile!;
    await expect(store.execute(await sign(operator, journal, 'signal.publish', signalData(narrow.id)))).rejects.toMatchObject({ code: 'invalid' });
    expect((await store.list()).signals).toHaveLength(1);
  });

  it('rejects malformed quantities, prices and theses', async () => {
    const { journal, store, profile } = await setup();
    for (const bad of [{ quantity: '0' }, { quantity: '-1' }, { quantity: '1e3' }, { limitPrice: '01.5' },
      { limitPrice: '1.1234567890123456789' }, { side: 'short' }, { thesis: 'x'.repeat(281) }, { orderType: 'market' }]) {
      await expect(store.execute(await sign(operator, journal, 'signal.publish', signalData(profile.id, bad)))).rejects.toMatchObject({ code: 'invalid' });
    }
  });

  it('lists newest signals first and caps the list', async () => {
    const { journal, store, profile } = await setup();
    for (let i = 0; i < 3; i++) {
      journal.nowMs += 1000;
      await store.execute(await sign(operator, journal, 'signal.publish', signalData(profile.id, { quantity: String(i + 1) })));
    }
    const { signals } = await store.list();
    expect(signals.map(s => s.quantity)).toEqual(['3', '2', '1']);
  });
});

describe('envelope verification', () => {
  it('rejects forged, foreign, expired and oversized envelopes before writing', async () => {
    const { journal, store, profile } = await setup();
    const good = await sign(owner, journal, 'profile.upsert', profileData({ profileId: profile.id }));
    // Tampering changes the recovered signer, so the edit is not attributed to the owner.
    const tampered = { ...good, payload: { ...good.payload, data: profileData({ profileId: profile.id, name: 'Swapped' }) } };
    await expect(store.execute(tampered)).rejects.toMatchObject({ code: 'forbidden' });
    const cases: [Partial<BotAction>, string][] = [
      [{ audience: 'https://evil.test' }, 'invalid'],
      [{ chainId: 1 as 8453 }, 'invalid'],
      [{ issuedAt: nowSec(journal) - 200, expiresAt: nowSec(journal) - 10 }, 'expired'],
      [{ issuedAt: nowSec(journal) - 400, expiresAt: nowSec(journal) - 10 }, 'invalid'],
      [{ issuedAt: nowSec(journal), expiresAt: nowSec(journal) + 301 }, 'invalid'],
      [{ issuedAt: nowSec(journal) + 120, expiresAt: nowSec(journal) + 200 }, 'expired'],
      [{ requestId: 'not-a-uuid' }, 'invalid'],
      [{ version: 2 as 1 }, 'invalid'],
    ];
    for (const [over, code] of cases) {
      await expect(store.execute(await sign(owner, journal, 'profile.upsert', profileData(), over))).rejects.toMatchObject({ code });
    }
    await expect(store.execute({ ...good, signature: `0x${'00'.repeat(65)}` })).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(store.execute({ ...good, signature: '0x1234' as Hex })).rejects.toMatchObject({ code: 'invalid' });
    await expect(store.execute(await sign(owner, journal, 'profile.upsert', profileData({ bio: 'x'.repeat(5000) })))).rejects.toMatchObject({ code: 'invalid' });
    expect(journal.appends).toBe(1);
  });

  it('validates profile fields', async () => {
    const journal = new FakeJournal(), store = new ProjectStore(journal, AUDIENCE);
    for (const bad of [{ name: 'x' }, { name: 'a'.repeat(41) }, { name: 'bad\u0000name' }, { bio: 'b'.repeat(281) },
      { style: 'Degen' }, { strategy: 'oracle' }, { assets: [] }, { assets: ['DOGE'] }, { operator: '0x123' },
      { operator: `0x${'0'.repeat(40)}` }, { profileId: 'abc' }, { verified: true }, { bio: `0x${'a'.repeat(130)}` }]) {
      await expect(store.execute(await sign(owner, journal, 'profile.upsert', profileData(bad)))).rejects.toMatchObject({ code: 'invalid' });
    }
    expect(journal.appends).toBe(0);
  });

  it('rejects racing writers explicitly instead of retrying', async () => {
    const journal = new FakeJournal();
    const replica: Journal = { canWrite: true, read: () => journal.read(), append: (e, n) => journal.append(e, n), close: async () => {} };
    const a = new ProjectStore(journal, AUDIENCE), b = new ProjectStore(replica, AUDIENCE);
    journal.barrier = { size: 2, waiting: [] };
    const results = await Promise.allSettled([
      a.execute(await sign(owner, journal, 'profile.upsert', profileData())),
      b.execute(await sign(owner, journal, 'profile.upsert', profileData())),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'conflict' } });
    expect(journal.events).toHaveLength(1);
  });
});

describe('replay contract for the host ledger', () => {
  it('ignores core commands and fails closed on invalid project history', async () => {
    const { journal, profile } = await setup();
    const core = { revision: 2, id: 'core', at: journal.nowMs, command: { type: 'job.complete', jobId: '1', leaseToken: randomUUID() } };
    expect(replayProject([...journal.events, core]).profiles.get(profile.id)?.name).toBe('Momentum Max');
    const forged = { revision: 3, id: 'forged', at: journal.nowMs, command: { type: 'project.bot', version: 1,
      actor: stranger.address.toLowerCase(), requestId: randomUUID(), digest: `0x${'ab'.repeat(32)}`, action: 'signal.publish',
      issuedAt: nowSec(journal), expiresAt: nowSec(journal) + 60, data: signalData(profile.id) } };
    expect(() => replayProject([...journal.events, core, forged])).toThrow(BotError);
    const command = journal.events[0].command as Record<string, unknown>;
    expect(validateProjectCommand(command)).toEqual(command);
    expect(() => validateProjectCommand({ ...command, signature: `0x${'ab'.repeat(65)}` })).toThrow(BotError);
    expect(() => validateProjectCommand({ type: 'job.complete' })).toThrow(BotError);
  });
});

describe('real ArkivJournal encoder compatibility', () => {
  it('stores project events through the nonce-fenced journal without tripping the secret filter', async () => {
    const writer = `0x${'1'.repeat(40)}`;
    const epoch = BigInt(Math.floor(Date.now() / 1000)) - 100n;
    const rows: StoredEvent[] = [];
    let tip = 100n;
    const port: ArkivPort = {
      canWrite: true,
      async chainId() { return 7794095; },
      async block(number = tip) { return { number, hash: `block-${number}`, timestamp: epoch + number }; },
      async nonce() { return rows.length; },
      async page(offset) { return { rows: rows.slice(offset, offset + 100), blockNumber: tip }; },
      async send(event) {
        rows.push({ event: structuredClone(event), creator: writer, owner: writer, readonly: true, expiresAt: 1000000n, createdAt: tip });
        tip += 3n;
        return `0x${'a'.repeat(64)}` as Hex;
      },
      async confirm() {},
    };
    const journal = new ArkivJournal(port, writer);
    const chainNow = (await journal.read()).timestampMs;
    const store = new ProjectStore(journal, AUDIENCE);
    const signed = async (signer: Signer, action: BotAction['action'], data: Record<string, unknown>) => {
      const payload: BotAction = { version: 1, audience: AUDIENCE, chainId: 8453, requestId: randomUUID(),
        issuedAt: Math.floor(chainNow / 1000) - 1, expiresAt: Math.floor(chainNow / 1000) + 200, action, data };
      return { payload, signature: await signer.signMessage({ message: botMessage(payload) }) };
    };
    const { profile } = await store.execute(await signed(owner, 'profile.upsert', profileData()));
    await store.execute(await signed(operator, 'signal.publish', signalData(profile!.id)));
    expect((await store.list()).signals).toHaveLength(1);
    expect(rows).toHaveLength(2);
  });
});
