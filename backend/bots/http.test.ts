import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { createApi } from '../api';
import { readConfig } from '../config';
import { Ledger } from '../ledger';
import { ProjectStore } from './store';
import { botMessage, type BotAction } from '../../shared/bots';
import { JournalError, type Journal, type JournalEvent } from '../arkiv-journal';

// Explicit journal contract double: never instantiated by runtime code.
class ContractJournal implements Journal {
  canWrite = true; events: JournalEvent[] = [];
  async read() { return { events: structuredClone(this.events), nonce: this.events.length, blockNumber: 1n, timestampMs: Date.now() }; }
  async append(event: JournalEvent, nonce: number) { if (nonce !== this.events.length) throw new JournalError('conflict', 'stale'); this.events.push(structuredClone(event)); }
  async close() {}
}
const servers: ReturnType<typeof createApi>[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); } });
const owner = privateKeyToAccount(`0x${'44'.repeat(32)}`);
async function setup() {
  const journal = new ContractJournal(), projects = new ProjectStore(journal, 'http://localhost:5173');
  const ledger = await Ledger.open(journal);
  const server = createApi({ config: readConfig({}), ledger, projects, executeBot: value => projects.execute(value), authenticate: async () => ({ userId: 'did:privy:test', wallets: [owner.address.toLowerCase()] }) });
  servers.push(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address() as { port: number }, base = `http://127.0.0.1:${address.port}`;
  const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const sign = async (action: BotAction['action'], data: Record<string, unknown>) => {
    const now = Math.floor(Date.now() / 1000);
    const payload: BotAction = { version: 1, chainId: 8453, audience: 'http://localhost:5173', requestId: randomUUID(), issuedAt: now, expiresAt: now + 300, action, data };
    return { payload, signature: await owner.signMessage({ message: botMessage(payload) }) };
  };
  return { journal, ledger, base, post, sign };
}
it('registers through REST, reads from MCP, publishes a proposal and revokes the operator', async () => {
  const f = await setup();
  const signed = await f.sign('profile.upsert', { name: 'Test bot', bio: 'A rule based trader', operator: owner.address, style: 'Steady', strategy: 'rule-based', assets: ['WETH'] });
  const created = await f.post('/api/bots/commands', signed);
  expect(created.status).toBe(200);
  const result = await created.json(); const profileId = result.profile.id;
  expect((await (await f.post('/api/bots/commands', signed)).json()).replayed).toBe(true);
  expect(f.journal.events).toHaveLength(1);
  expect(JSON.stringify(f.journal.events)).not.toContain(signed.signature);
  const listed = await (await f.post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'swipr_list_bots', arguments: {} } })).json();
  expect(listed.result.isError).toBe(false);
  expect(JSON.parse(listed.result.content[0].text).profiles[0].id).toBe(profileId);
  const signal = await f.sign('signal.publish', { profileId, asset: 'WETH', side: 'buy', quantity: '0.01', limitPrice: '3000' });
  expect((await f.post('/api/bots/commands', signal)).status).toBe(200);
  expect((await (await fetch(f.base + '/api/bots')).json()).signals[0].kind).toBe('proposal');
  expect((await f.post('/api/bots/commands', await f.sign('profile.halt', { profileId }))).status).toBe(200);
  expect((await f.post('/api/bots/commands', await f.sign('signal.publish', signal.payload.data))).status).toBe(409);
  expect((await f.ledger.health()).ok).toBe(true); // core replay tolerates and validates bot events
});
it('returns JSON-RPC parse errors and never executes mutation notifications', async () => {
  const f = await setup();
  const invalid = await fetch(f.base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  expect(invalid.status).toBe(400); expect((await invalid.json()).error.code).toBe(-32700);
  const notification = await f.post('/mcp', { jsonrpc: '2.0', method: 'tools/call', params: { name: 'swipr_register_bot', arguments: {} } });
  expect(notification.status).toBe(202); expect(f.journal.events).toEqual([]);
  expect((await fetch(f.base + '/mcp')).status).toBe(405);
});
it('rejects cross-origin mutations and malformed or tampered wallet envelopes', async () => {
  const f = await setup();
  expect((await fetch(f.base + '/api/bots/commands', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
  expect((await f.post('/api/bots/commands', { payload: {}, signature: 'bad' })).status).toBe(400);
  expect(f.journal.events).toEqual([]);
});
