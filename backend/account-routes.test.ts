import { afterEach, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createApi } from './api';
import { readConfig } from './config';

const wallet = `0x${'12'.repeat(20)}`;
const servers: Server[] = [];
afterEach(async () => { for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise(r => s.close(r)); } });
async function start() {
  const fundGas = vi.fn(async () => ({ funded: false }));
  const remove = vi.fn(async () => ({ deleted: true }));
  const server = createApi({ config: readConfig({}), ledger: null,
    authenticate: async () => ({ userId: 'did:privy:owner', wallets: [wallet] }), fundGas,
    account: { health: async () => ({ ok: true }), list: async () => [], remove } });
  servers.push(server); await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const a = server.address(); if (!a || typeof a === 'string') throw new Error('No port');
  return { base: `http://127.0.0.1:${a.port}`, fundGas, remove };
}
it('binds a gas grant to the authenticated user, ignoring a supplied subject', async () => {
  const { base, fundGas } = await start();
  expect((await fetch(`${base}/api/arkiv/gas`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ wallet, subject: 'did:privy:victim' }) })).status).toBe(200);
  expect(fundGas).toHaveBeenCalledExactlyOnceWith({ wallet, subject: 'did:privy:owner' });
});
it('never funds or deletes another wallet’s account', async () => {
  const { base, fundGas, remove } = await start();
  for (const path of ['/api/arkiv/gas', '/api/account/delete']) {
    expect((await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wallet: `0x${'34'.repeat(20)}` }) })).status).toBe(403);
  }
  expect(fundGas).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
});

it('reports native storage readiness without enabling trading or requiring a journal writer', async () => {
  const { base } = await start();
  expect((await fetch(`${base}/ready`)).status).toBe(200);
  expect(await (await fetch(`${base}/api/runtime`)).json()).toMatchObject({ tradingEnabled: false });
});
