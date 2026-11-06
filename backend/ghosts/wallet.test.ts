import { describe, it, expect } from 'vitest';
import { bytes, str } from '@arkiv-network/sdk/schema';
import type { FullEntity } from '@arkiv-network/sdk';
import type { AddressInfo } from 'node:net';
import { decodeWalletGhost } from './wallet';
import { WALLET_GHOST_SCHEMA, WALLET_PROFILE_PROJECT } from '../contracts/wallet-profile';
import { activeWalletGhosts, parseWalletGhost } from '../contracts/ghosts';
import { createApi } from '../api';
import { ApiError } from '../auth';
import { readConfig } from '../config';
const wallet = `0x${'12'.repeat(20)}`, other = `0x${'34'.repeat(20)}`;
const ghost = { traderId: `0x${'ab'.repeat(32)}`, startedAt: 1700000000000, expiresAt: 1700604800000,
  perTradeUsd: 10, includedSignalId: null };
const entity = () => ({ $key: `0x${'cd'.repeat(32)}`, $owner: wallet, $attributes: {
  'arkiv.schema': str(WALLET_GHOST_SCHEMA), project: str(WALLET_PROFILE_PROJECT), status: str('active'),
  ghost: bytes(new TextEncoder().encode(JSON.stringify(ghost))),
} } as unknown as FullEntity);
describe('wallet-owned ghost records', () => {
  it('uses native ownership and rejects copied schema and injected profits', () => {
    expect(decodeWalletGhost(entity(), wallet).ghost).toEqual(ghost);
    expect(() => decodeWalletGhost(entity(), other)).toThrow();
    expect(() => parseWalletGhost({ ...ghost, profit: 100 })).toThrow();
    expect(() => parseWalletGhost({ ...ghost, perTradeUsd: 51 })).toThrow();
    expect(() => parseWalletGhost({ ...ghost, expiresAt: ghost.startedAt })).toThrow();
  });
  it('keeps original starts and excludes removed records', () => {
    const record = decodeWalletGhost(entity(), wallet);
    expect(activeWalletGhosts([{ ...record, ghost: { ...ghost, startedAt: ghost.startedAt + 1000 } }, record])).toEqual([ghost]);
    expect(activeWalletGhosts([{ ...record, status: 'removed' }])).toEqual([]);
  });
  it('requires authentication and a linked owner wallet for account reads', async () => {
    const server = createApi({ config: readConfig({}), ledger: null,
      authenticate: async auth => { if (auth !== 'Bearer test') throw new ApiError(401, 'unauthorized', 'Sign in.'); return { userId: 'test', wallets: [wallet] }; },
      walletGhosts: async owner => { expect(owner).toBe(wallet); return [decodeWalletGhost(entity(), owner)]; },
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ghosts`;
    try {
      expect((await fetch(`${url}?wallet=${wallet}`)).status).toBe(401);
      expect((await fetch(`${url}?wallet=${other}`, { headers: { authorization: 'Bearer test' } })).status).toBe(403);
      const result = await fetch(`${url}?wallet=${wallet}`, { headers: { authorization: 'Bearer test' } });
      expect(result.status).toBe(200);
      expect((await result.json()).records[0].ghost).toEqual(ghost);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
