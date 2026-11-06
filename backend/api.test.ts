import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApi } from './api';
import { readConfig } from './config';
const running: Server[] = [];
afterEach(async () => { await Promise.all(running.splice(0).map(s => new Promise<void>(r => { s.closeAllConnections(); s.close(() => r()); }))); });
async function start(authenticated = false) {
  const server = createApi({ config: readConfig({}), ledger: null, ...(authenticated ? { authenticate: async () => ({ userId: 'test', wallets: [`0x${'a'.repeat(40)}`] }) } : {}) });
  running.push(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}
describe('HTTP service gates', () => {
  it('separates process health, database readiness and trading readiness', async () => {
    const base = await start();
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/readyz`)).status).toBe(503);
    expect(await (await fetch(`${base}/api/runtime`)).json()).toMatchObject({ tradingEnabled: false });
    expect(await (await fetch(`${base}/api/traders`)).json()).toMatchObject({ traders: [], asOfBlock: null });
  });
  it('rejects disallowed browser origins and private unauthenticated requests', async () => {
    const base = await start();
    expect((await fetch(`${base}/api/runtime`, { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await fetch(`${base}/api/passes`)).status).toBe(503);
    const response = await fetch(`${base}/api/runtime`, { headers: { origin: 'http://localhost:5173' } });
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('never accepts fabricated activation proof or another wallet', async () => {
    const base = await start(true);
    const post = (path: string, wallet: string) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet, confirmed: true, txHash: 'fabricated' }) });
    expect((await post('/api/passes', `0x${'b'.repeat(40)}`)).status).toBe(403);
    const response = await post('/api/orders', `0x${'a'.repeat(40)}`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'execution_unavailable' } });
  });
});
