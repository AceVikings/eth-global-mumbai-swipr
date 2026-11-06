import { describe, it, expect } from 'vitest';
import type { FullEntity } from '@arkiv-network/sdk';
import { bytes, str } from '@arkiv-network/sdk/schema';
import { decodeWalletSignal } from './wallet-signals';
import { WALLET_SIGNAL_SCHEMA, WALLET_PROFILE_PROJECT } from '../contracts/wallet-profile';
const operator = `0x${'12'.repeat(20)}`;
const profileId = `0x${'ab'.repeat(32)}`;
const profile = { id: profileId, owner: operator, operator, name: 'Trader', bio: '', style: 'Balanced' as const,
  strategy: 'manual' as const, assets: ['WETH' as const], status: 'active' as const, createdAt: '', updatedAt: '' };
const signal = { profileId, asset: 'WETH', side: 'buy', quantity: '0.01', limitPrice: '3000', thesis: 'A proposal.' };
const entity = (data: unknown = signal) => ({ $key: `0x${'cd'.repeat(32)}`, $owner: operator,
  $attributes: { 'arkiv.schema': str(WALLET_SIGNAL_SCHEMA), project: str(WALLET_PROFILE_PROJECT),
    profileId: str(profileId), signal: bytes(new TextEncoder().encode(JSON.stringify(data))) } } as unknown as FullEntity);

describe('wallet signal authority', () => {
  it('reads native operator-owned proposals without treating them as fills', () => {
    expect(decodeWalletSignal(entity(), [profile], 1700000000)).toMatchObject({ ...signal, operator, kind: 'proposal' });
    expect(decodeWalletSignal(entity(), [profile], 1700000000)).not.toHaveProperty('profit');
  });
  it('rejects a copied schema from another wallet and an operator rotated out', () => {
    expect(() => decodeWalletSignal({ ...entity(), $owner: `0x${'34'.repeat(20)}` }, [profile], 1)).toThrow();
    expect(() => decodeWalletSignal(entity(), [{ ...profile, operator: `0x${'34'.repeat(20)}` }], 1)).toThrow();
  });
  it('rejects halted/deleted profiles and injected execution facts', () => {
    expect(() => decodeWalletSignal(entity(), [{ ...profile, status: 'halted' }], 1)).toThrow();
    expect(() => decodeWalletSignal(entity(), [], 1)).toThrow();
    expect(() => decodeWalletSignal(entity({ ...signal, profit: '100' }), [profile], 1)).toThrow();
  });
});
