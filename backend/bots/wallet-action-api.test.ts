import { it, expect } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createApi } from '../api';
import { readConfig } from '../config';

it('prepares the same wallet-owned writes through REST and MCP, with no central writer', async () => {
  const wallet = `0x${'12'.repeat(20)}`;
  const id = `0x${'ab'.repeat(32)}`;
  const profile = { id, owner: wallet, operator: wallet, name: 'Trader', bio: '', style: 'Balanced' as const,
    strategy: 'manual' as const, assets: ['WETH' as const], status: 'active' as const, createdAt: '', updatedAt: '' };
  const server = createApi({ config: readConfig({}), ledger: null, walletProfiles: async () => [profile], walletSignals: async () => [] });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, input: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  try {
    const args = { wallet, action: 'signal.publish', data: { profileId: id, asset: 'WETH', side: 'buy', quantity: '0.01', limitPrice: '3000' } };
    const rest = await post('/api/bots/wallet-transaction', args);
    expect(rest.status).toBe(200);
    expect(await rest.json()).toMatchObject({ requiresWalletApproval: true, kind: 'proposal', transaction: { from: wallet, value: '0x0' } });
    const rpc = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'swipr_prepare_wallet_action', arguments: args } });
    const result = await rpc.json();
    expect(result.result.isError).toBe(false);
    expect(JSON.parse(result.result.content[0].text)).toMatchObject({ requiresWalletApproval: true, transaction: { from: wallet } });
    const list = await post('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const names = (await list.json()).result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('swipr_prepare_wallet_action');
    expect(names).not.toContain('swipr_register_bot');
    const bad = await post('/api/bots/wallet-transaction', { ...args, wallet: `0x${'34'.repeat(20)}` });
    expect(bad.status).toBe(403);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});
