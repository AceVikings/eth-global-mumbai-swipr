import { expect, it, vi, beforeEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createApi } from './api';
import { ApiError } from './auth';
import { readConfig } from './config';
import { createWalletBalance, displayUnits } from './wallet-balance';
const client = vi.hoisted(() => ({ getChainId: vi.fn(), getBlockNumber: vi.fn(), getBalance: vi.fn(), readContract: vi.fn() }));
vi.mock('viem', async original => ({ ...await original<typeof import('viem')>(), createPublicClient: () => client }));
const wallet = `0x${'12'.repeat(20)}`, other = `0x${'34'.repeat(20)}`;
beforeEach(() => { vi.resetAllMocks(); client.getChainId.mockResolvedValue(8453); client.getBlockNumber.mockResolvedValue(100n); client.getBalance.mockResolvedValue(1234567890000000n); client.readContract.mockResolvedValue(123456789n); });
it('reads USDC and gas at the same Base block and formats exact units', async () => {
  expect(await createWalletBalance('https://mainnet.base.org')(wallet)).toMatchObject({ address: wallet, display: '123.45 USDC', gasDisplay: '0.001234 ETH', blockNumber: '100' });
  expect(client.getBalance).toHaveBeenCalledWith({ address: wallet, blockNumber: 100n });
  expect(client.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'balanceOf', args: [wallet], blockNumber: 100n }));
  expect(displayUnits(0n, 6, 2)).toBe('0.00');
  expect(displayUnits(123456789123456789n, 6, 2)).toBe('123,456,789,123.45');
});
it('rejects the wrong chain and RPC failures instead of fabricating zero', async () => {
  client.getChainId.mockResolvedValueOnce(1);
  await expect(createWalletBalance('https://mainnet.base.org')(wallet)).rejects.toThrow();
  expect(client.readContract).not.toHaveBeenCalled();
  client.readContract.mockRejectedValueOnce(new Error('offline'));
  await expect(createWalletBalance('https://mainnet.base.org')(wallet)).rejects.toThrow('offline');
});
it('requires a linked wallet and returns an explicit unavailable state on failure', async () => {
  const read = vi.fn().mockResolvedValue({ address: wallet, chainId: 8453, display: '0.00 USDC', gasDisplay: '0.000000 ETH' });
  const server = createApi({ config: readConfig({}), ledger: null, walletBalance: read,
    authenticate: async header => { if (!header) throw new ApiError(401, 'unauthorized', 'Sign in'); return { userId: 'test', wallets: [wallet] }; } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/wallet?address=`;
  const headers = { authorization: 'Bearer test' };
  try {
    expect((await fetch(url + wallet)).status).toBe(401);
    expect((await fetch(url + other, { headers })).status).toBe(403);
    expect(read).not.toHaveBeenCalled();
    const response = await fetch(url + wallet, { headers });
    expect(response.status).toBe(200); expect((await response.json()).display).toBe('0.00 USDC');
    read.mockRejectedValueOnce(new Error('RPC down'));
    const failed = await fetch(url + wallet, { headers });
    expect(failed.status).toBe(503); expect((await failed.json()).error.code).toBe('balance_unavailable');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
