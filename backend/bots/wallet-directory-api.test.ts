import { expect, it } from 'vitest';
import { createApi } from '../api';
import { readConfig } from '../config';
import type { AddressInfo } from 'node:net';

it('serves the native wallet directory without a central writer or ledger', async () => {
  const server = createApi({ config: readConfig({}), ledger: null,
    walletProfiles: async () => [{ id: `0x${'ab'.repeat(32)}`, owner: `0x${'12'.repeat(20)}`,
      operator: `0x${'12'.repeat(20)}`, name: 'Test profile', bio: '', style: 'Balanced',
      strategy: 'manual', assets: ['WETH'], status: 'active', storage: 'wallet',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }] });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const response = await fetch(`${base}/api/bots`);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.state).toBe('ready');
    expect(result.profiles[0]).toMatchObject({ storage: 'wallet', owner: `0x${'12'.repeat(20)}` });
    expect(result.signals).toEqual([]);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
