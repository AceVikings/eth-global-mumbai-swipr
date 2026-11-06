import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { createApi } from '../api';
import { readConfig } from '../config';
import { JournalError, type Journal, type JournalEvent } from '../arkiv-journal';
import { Ledger } from '../ledger';
import { ProjectStore } from '../bots/store';
import { botMessage, type BotAction } from '../../shared/bots';
import { SocialStore } from './store';
import { socialMessage, type SocialAction } from '../../shared/social';
import type { VerifiedClosedPosition } from './rankings';

// Only tests instantiate this double. Runtime always reads and writes Arkiv.
class TestJournal implements Journal {
  canWrite = true; events: JournalEvent[] = [];
  async read() { await new Promise(r => setImmediate(r)); return { events: structuredClone(this.events), nonce: this.events.length, blockNumber: 1n, timestampMs: Date.now() }; }
  async append(e: JournalEvent, nonce: number) { if (nonce !== this.events.length) throw new JournalError('conflict', 'nonce'); this.events.push(e); }
  async close() {}
}
const alice = privateKeyToAccount(`0x${'66'.repeat(32)}`);
const bob = privateKeyToAccount(`0x${'77'.repeat(32)}`);
const servers: ReturnType<typeof createApi>[] = [];
afterEach(async () => { for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())); } });
const audience = 'http://localhost:5173';
const times = () => { const issuedAt = Math.floor(Date.now() / 1000); return { version: 1 as const, chainId: 8453 as const, audience, requestId: randomUUID(), issuedAt, expiresAt: issuedAt + 300 }; };
async function setup(fills = false) {
  const journal = new TestJournal(), ledger = await Ledger.open(journal);
  const social = new SocialStore(journal, audience), projects = new ProjectStore(journal, audience);
  const position: VerifiedClosedPosition = { id: 'confirmed-closed-position', wallet: bob.address, role: 'copier', name: 'Bob', costUsdMicros: '10000000', proceedsUsdMicros: '12000000', feesUsdMicros: '100000', profitShareUsdMicros: '90000', closedAt: new Date().toISOString(), entryTx: `0x${'a'.repeat(64)}`, exitTx: `0x${'b'.repeat(64)}` };
  const server = createApi({ config: readConfig({}), ledger, social, projects, executeSocial: i => social.execute(i),
    authenticate: async auth => { if (auth !== 'Bearer test') throw new (await import('../auth')).ApiError(401, 'unauthorized', 'Sign in'); return { userId: 'did:privy:test', wallets: [alice.address.toLowerCase()] }; },
    ...(fills ? { verifiedPositions: async () => ({ positions: [position], asOf: position.closedAt }) } : {}) });
  servers.push(server); await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const get = (path: string, auth = true) => fetch(base + path, { headers: auth ? { authorization: 'Bearer test' } : {} });
  const post = (signed: unknown) => fetch(base + '/api/social/commands', { method: 'POST', headers: { authorization: 'Bearer test', 'content-type': 'application/json' }, body: JSON.stringify(signed) });
  const sign = async (action: SocialAction['action'], account = alice) => { const payload: SocialAction = { ...times(), action, target: bob.address }; return { payload, signature: await account.signMessage({ message: socialMessage(payload) }) }; };
  return { journal, ledger, social, projects, get, post, sign };
}
it('follows, filters copier profit ranks, and unfollows through authenticated HTTP', async () => {
  const f = await setup(true), signed = await f.sign('follow');
  expect((await f.post(signed)).status).toBe(200);
  expect((await (await f.post(signed)).json()).replayed).toBe(true);
  const query = `/api/leaderboards?role=copier&sort=absolute&scope=following&wallet=${alice.address}`;
  const result = await (await f.get(query)).json();
  expect(result.rows).toMatchObject([{ name: 'Bob', netProfitUsd: '1.81', returnPct: '18.10' }]);
  expect((await f.get(query, false)).status).toBe(401);
  expect((await f.get(`/api/social?wallet=${bob.address}`)).status).toBe(403);
  expect((await f.post(await f.sign('unfollow'))).status).toBe(200);
  expect((await (await f.get(query)).json()).rows).toEqual([]);
  expect(JSON.stringify(f.journal.events)).not.toContain(signed.signature);
  expect((await f.ledger.health()).ok).toBe(true);
});
it('keeps unavailable performance distinct from empty ranks and rejects client profits', async () => {
  const f = await setup();
  expect(await (await f.get('/api/leaderboards', false)).json()).toMatchObject({ state: 'unavailable', rows: [], asOf: null });
  expect((await f.get('/api/leaderboards?sort=bogus')).status).toBe(400);
  const signed = await f.sign('follow');
  expect((await f.post({ ...signed, profit: 999 })).status).toBe(400);
  expect(f.journal.events).toHaveLength(0);
  expect((await f.post(await f.sign('follow', bob))).status).toBe(403);
});
it('serializes core, bot and social writes on the shared worker journal', async () => {
  const f = await setup(), follow = await f.sign('follow');
  const payload: BotAction = { ...times(), action: 'profile.upsert', data: { name: 'Test bot', bio: '', operator: alice.address, style: 'Steady', strategy: 'rule-based', assets: ['WETH'] } };
  const bot = { payload, signature: await alice.signMessage({ message: botMessage(payload) }) };
  await Promise.all([f.social.execute(follow), f.projects.execute(bot), f.ledger.enqueueJob('probe-base', {}, { dedupeKey: 'probe' })]);
  expect(f.journal.events.map(e => e.revision)).toEqual([1, 2, 3]);
  expect((await f.ledger.health()).ok).toBe(true);
});
