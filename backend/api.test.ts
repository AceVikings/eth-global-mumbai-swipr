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

it('routes authenticated preflight to the worker that owns durable pass accounting',async()=>{
 const wallet=`0x${'a'.repeat(40)}`,forwarded:unknown[]=[];
 const server=createApi({config:readConfig({FLASH_KEY_EXEC:'test',PRIVY_APP_SECRET:'test',WORKER_URL:'http://127.0.0.1:8788'}),ledger:null,
  walletProfiles:async()=>[],seatDirectory:async()=>({passes:[],availability:[],invitations:[]}),
  authenticate:async()=>({userId:'test',wallets:[wallet]}),
  fetcher:async(url,init)=>{expect(String(url)).toBe('http://127.0.0.1:8788/internal/trading');forwarded.push(JSON.parse(String(init?.body)));return new Response(JSON.stringify({ready:true}));}});
 running.push(server);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const address=server.address();if(!address||typeof address==='string')throw Error('no listener');
 const response=await fetch(`http://127.0.0.1:${address.port}/api/trades/preflight`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({wallet,ticket:'reviewed-ticket'})});
 expect(response.status).toBe(200);expect(await response.json()).toEqual({ready:true});
 expect(forwarded).toEqual([{action:'preflight',wallet,ticket:'reviewed-ticket'}]);
});
