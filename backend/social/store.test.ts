import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { keccak256, stringToBytes, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { SOCIAL_LIMITS, socialMessage, type SignedSocialAction, type SocialAction } from '../contracts/social';
import { JournalError, type Journal, type JournalEvent, type JournalSnapshot } from '../arkiv-journal';
import { BotError } from '../bots/validation';
import { replaySocial, SocialStore, validateSocialCommand, type SocialCommand } from './store';

const AUDIENCE = 'https://swipr.test';
const alice = privateKeyToAccount(`0x${'11'.repeat(32)}` as Hex);
const bob = privateKeyToAccount(`0x${'22'.repeat(32)}` as Hex);
const carol = privateKeyToAccount(`0x${'33'.repeat(32)}` as Hex);
const lower = (a: { address: string }) => a.address.toLowerCase();
type Signer = typeof alice;

/** TEST-ONLY contract double of the nonce-fenced Arkiv journal. Runtime always uses ArkivJournal. */
class TestOnlyJournal implements Journal {
  canWrite = true;
  events: JournalEvent[] = [];
  nowMs = Date.now();
  failNext: JournalError | null = null;
  async read(): Promise<JournalSnapshot> {
    return structuredClone({ events: this.events, nonce: this.events.length, blockNumber: 1n, timestampMs: this.nowMs });
  }
  async append(event: JournalEvent, expectedNonce: number) {
    await Promise.resolve();
    if (this.failNext) { const e = this.failNext; this.failNext = null; throw e; }
    if (expectedNonce !== this.events.length || event.revision !== expectedNonce + 1) throw new JournalError('conflict', 'Stale writer revision.');
    this.events.push(structuredClone(event));
  }
  async close() {}
}

const nowSec = (j: TestOnlyJournal) => Math.floor(j.nowMs / 1000);
async function sign(signer: Signer, j: TestOnlyJournal, action: SocialAction['action'], target: string,
  over: Partial<SocialAction> = {}): Promise<SignedSocialAction> {
  const payload: SocialAction = { version: 1, audience: AUDIENCE, chainId: 8453, requestId: randomUUID(),
    issuedAt: nowSec(j) - 5, expiresAt: nowSec(j) + 120, action, target, ...over };
  return { payload, signature: await signer.signMessage({ message: socialMessage(payload) }) };
}
async function rejects(promise: Promise<unknown>, code: string) {
  const error = await promise.then(() => null, (e: BotError) => e);
  expect(error).toBeInstanceOf(BotError);
  expect(error?.code).toBe(code);
}
const setup = () => { const journal = new TestOnlyJournal(); return { journal, store: new SocialStore(journal, AUDIENCE) }; };

describe('SocialStore follow graph', () => {
  it('follows and unfollows as the recovered signer, storing a keccak digest and no signature', async () => {
    const { journal, store } = setup();
    const env = await sign(alice, journal, 'follow', bob.address);
    expect(await store.execute(env)).toEqual({ following: [lower(bob)], replayed: false });
    expect(await store.execute(await sign(alice, journal, 'follow', carol.address.toLowerCase()))).toEqual({
      following: [lower(bob), lower(carol)].sort(), replayed: false });
    const command = journal.events[0].command as SocialCommand;
    expect(command).toEqual({ type: 'project.social', version: 1, actor: lower(alice), requestId: env.payload.requestId,
      digest: keccak256(stringToBytes(socialMessage(env.payload))), action: 'follow', target: lower(bob),
      issuedAt: env.payload.issuedAt, expiresAt: env.payload.expiresAt });
    expect(JSON.stringify(journal.events)).not.toMatch(/signature|0x[0-9a-f]{130}/i);
    expect(await store.execute(await sign(alice, journal, 'unfollow', bob.address))).toEqual({ following: [lower(carol)], replayed: false });
    expect(await store.following(alice.address)).toEqual([lower(carol)]);
    expect(await store.following(bob.address)).toEqual([]);
  });

  it('rejects self-follow, duplicate follow and unfollowing a stranger without writing', async () => {
    const { journal, store } = setup();
    await rejects(store.execute(await sign(alice, journal, 'follow', alice.address)), 'invalid');
    await store.execute(await sign(alice, journal, 'follow', bob.address));
    await rejects(store.execute(await sign(alice, journal, 'follow', bob.address)), 'conflict');
    await rejects(store.execute(await sign(alice, journal, 'unfollow', carol.address)), 'not_found');
    expect(journal.events).toHaveLength(1);
  });

  it('replays an exact envelope after expiry and rejects a changed payload under the same requestId', async () => {
    const { journal, store } = setup();
    const env = await sign(alice, journal, 'follow', bob.address);
    await store.execute(env);
    journal.nowMs += 3_600_000; // long past expiresAt
    expect(await new SocialStore(journal, AUDIENCE).execute(structuredClone(env))).toEqual({ following: [lower(bob)], replayed: true });
    const changed = await sign(alice, journal, 'follow', carol.address, { requestId: env.payload.requestId });
    await rejects(store.execute(changed), 'conflict');
    const stolen = await sign(bob, journal, 'follow', carol.address, { ...env.payload, target: carol.address });
    await rejects(store.execute(stolen), 'conflict');
    expect(journal.events).toHaveLength(1);
  });

  it('lets a client resend the same envelope after an ambiguous write', async () => {
    const { journal, store } = setup();
    const env = await sign(alice, journal, 'follow', bob.address);
    journal.failNext = new JournalError('ambiguous', 'uncertain');
    await rejects(store.execute(env), 'ambiguous');
    expect(await store.execute(env)).toEqual({ following: [lower(bob)], replayed: false });
  });

  it('rejects forged, foreign, malformed, stale and future envelopes before writing', async () => {
    const { journal, store } = setup();
    const good = await sign(alice, journal, 'follow', bob.address);
    const s = nowSec(journal);
    const cases: [unknown, string][] = [
      [{ ...good, extra: 1 }, 'invalid'],
      [{ ...good, payload: { ...good.payload, memo: 'x' } }, 'invalid'],
      [{ ...good, signature: '0x1234' }, 'invalid'],
      [await sign(alice, journal, 'follow', bob.address, { audience: 'https://evil.test' }), 'invalid'],
      [await sign(alice, journal, 'follow', bob.address, { chainId: 1 as 8453 }), 'invalid'],
      [await sign(alice, journal, 'follow', bob.address, { requestId: 'nope' }), 'invalid'],
      [await sign(alice, journal, 'follow', '0x1234'), 'invalid'],
      [await sign(alice, journal, 'follow', `0x${'0'.repeat(40)}`), 'invalid'],
      [await sign(alice, journal, 'block' as 'follow', bob.address), 'invalid'],
      [await sign(alice, journal, 'follow', bob.address, { issuedAt: s, expiresAt: s + 301 }), 'invalid'],
      [await sign(alice, journal, 'follow', bob.address, { issuedAt: s - 200, expiresAt: s - 10 }), 'expired'],
      [await sign(alice, journal, 'follow', bob.address, { issuedAt: s + 120, expiresAt: s + 200 }), 'expired'],
      [{ ...good, payload: { ...good.payload, target: `${bob.address}${' '.repeat(3000)}` } }, 'invalid'],
    ];
    for (const [envelope, code] of cases) await rejects(store.execute(envelope), code);
    // A tampered target recovers some other wallet, so it can never land as alice.
    const tampered = { ...good, payload: { ...good.payload, target: carol.address } };
    await store.execute(tampered).catch(() => undefined);
    expect(await store.following(alice.address)).toEqual([]);
    expect(journal.events.every(e => (e.command as SocialCommand).actor !== lower(alice))).toBe(true);
  });

  it('caps active follows per actor and global writes per hour', async () => {
    const { journal, store } = setup();
    const targets = Array.from({ length: SOCIAL_LIMITS.followingPerActor + 1 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`);
    for (const target of targets.slice(0, -1)) await store.execute(await sign(alice, journal, 'follow', target));
    await rejects(store.execute(await sign(alice, journal, 'follow', targets.at(-1)!)), 'limit');
    await store.execute(await sign(alice, journal, 'unfollow', targets[0]));
    await store.execute(await sign(alice, journal, 'follow', targets.at(-1)!)); // room again after unfollow
    for (let i = journal.events.length; i < SOCIAL_LIMITS.writesPerHour; i++) {
      await store.execute(await sign(bob, journal, i % 2 ? 'unfollow' : 'follow', carol.address));
    }
    await rejects(store.execute(await sign(carol, journal, 'follow', bob.address)), 'limit');
    journal.nowMs += 3_600_001;
    expect((await store.execute(await sign(carol, journal, 'follow', bob.address))).following).toEqual([lower(bob)]);
  });

  it('refuses writes on a read-only journal and surfaces journal outages instead of falling back', async () => {
    const { journal, store } = setup();
    journal.canWrite = false;
    await rejects(store.execute(await sign(alice, journal, 'follow', bob.address)), 'read_only');
    journal.read = async () => { throw new JournalError('unavailable', 'down'); };
    await rejects(store.following(alice.address), 'unavailable');
  });

  it('serializes concurrent writes through the shared journal write queue', async () => {
    const { journal, store } = setup();
    const other = new SocialStore(journal, AUDIENCE);
    const results = await Promise.all([
      store.execute(await sign(alice, journal, 'follow', bob.address)),
      other.execute(await sign(alice, journal, 'follow', carol.address)),
    ]);
    expect(results.map(r => r.replayed)).toEqual([false, false]);
    expect(journal.events.map(e => e.revision)).toEqual([1, 2]);
  });
});

describe('replaySocial', () => {
  it('skips other namespaces and fails closed on tampered social history', async () => {
    const { journal, store } = setup();
    journal.events.push({ revision: 1, id: 'core', at: journal.nowMs, command: { type: 'project.bot', anything: true } });
    await store.execute(await sign(alice, journal, 'follow', bob.address));
    expect(replaySocial(journal.events).following.get(lower(alice))).toEqual(new Set([lower(bob)]));
    const valid = journal.events[1].command as SocialCommand;
    for (const bad of [{ ...valid, signature: '0x' }, { ...valid, target: bob.address },
      { ...valid, digest: 'x' }, { ...valid, expiresAt: valid.issuedAt + 301 }]) {
      expect(() => validateSocialCommand(bad)).toThrow(BotError);
      expect(() => replaySocial([{ ...journal.events[1], command: bad }])).toThrow(/social journal invalid/);
    }
    expect(() => replaySocial([{ ...journal.events[1], command: { ...valid, target: valid.actor } }])).toThrow(/social journal invalid/);
    expect(() => replaySocial([journal.events[1], { ...journal.events[1], revision: 3 }])).toThrow(/revision 3/);
    expect(() => replaySocial([{ ...journal.events[1], at: (valid.expiresAt + 1) * 1000 }])).toThrow(/social journal invalid/);
  });
});
