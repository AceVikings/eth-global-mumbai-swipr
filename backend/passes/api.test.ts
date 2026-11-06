import { it, expect } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createApi } from '../api';
import { readConfig } from '../config';
import { ApiError } from '../auth';
it('isolates wallet passes by authenticated linked wallet and forbids service-owned writes', async () => {
  const wallet = `0x${'12'.repeat(20)}`, other = `0x${'34'.repeat(20)}`;
  const server = createApi({ config: readConfig({}), ledger: null, walletProfiles: async () => [],
    authenticate: async header => { if (header !== 'Bearer test') throw new ApiError(401, 'unauthorized', 'Sign in.'); return { userId: 'test', wallets: [wallet] }; },
    walletPasses: async owner => { expect(owner).toBe(wallet); return []; },
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/passes`;
  const headers = { authorization: 'Bearer test', 'content-type': 'application/json' };
  try {
    expect((await fetch(`${url}?wallet=${wallet}`)).status).toBe(401);
    expect((await fetch(`${url}?wallet=${other}`, { headers })).status).toBe(403);
    const own = await fetch(`${url}?wallet=${wallet}`, { headers });
    expect(own.status).toBe(200); expect(await own.json()).toEqual({ passes: [] });
    const write = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ wallet, terms: {} }) });
    expect(write.status).toBe(409); expect((await write.json()).error.code).toBe('wallet_transaction_required');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
