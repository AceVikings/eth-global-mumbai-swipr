import { describe, expect, it } from 'vitest';
import type { FullEntity } from '@arkiv-network/sdk';
import { str } from '@arkiv-network/sdk/schema';
import { decodeWalletProfile } from './wallet-directory';
import { WALLET_PROFILE_PROJECT, WALLET_PROFILE_SCHEMA } from '../contracts/wallet-profile';
const owner = `0x${'12'.repeat(20)}`, creator = `0x${'34'.repeat(20)}`;
const data = { name: 'Testing trader', bio: 'A manual test profile.', operator: owner,
  style: 'Balanced', strategy: 'manual', assets: ['WETH'] };
const entity = (profile: unknown = data) => ({
  $key: `0x${'ab'.repeat(32)}`, $owner: owner, $creator: creator,
  $attributes: { 'arkiv.schema': { type: 'str', value: WALLET_PROFILE_SCHEMA },
    project: { type: 'str', value: WALLET_PROFILE_PROJECT },
    profile: { type: 'str', value: JSON.stringify(profile) }, status: { type: 'str', value: 'active' } },
} as unknown as FullEntity);

describe('native wallet profile authority', () => {
  it('uses chain ownership and entity identity even when another account created it', () => {
    const profile = decodeWalletProfile(entity(), 1700000000, 1700000010);
    expect(profile.owner).toBe(owner);
    expect(profile.owner).not.toBe(creator);
    expect(profile.id).toBe(entity().$key);
    expect(profile.storage).toBe('wallet');
    expect(profile).not.toHaveProperty('returnPct');
  });
  it('rejects owner claims and performance claims in user-editable contents', () => {
    expect(() => decodeWalletProfile(entity({ ...data, owner: creator }), 1, 2)).toThrow();
    expect(() => decodeWalletProfile(entity({ ...data, returnPct: '90' }), 1, 2)).toThrow();
  });
  it('reflects ownership transfers from chain metadata', () => {
    const row = { ...entity(), $owner: creator as `0x${string}` };
    expect(decodeWalletProfile(row, 1, 2).owner).toBe(creator);
  });
  it('rejects foreign project/schema tags and invalid status', () => {
    for (const key of ['project', 'arkiv.schema', 'status']) {
      const original = entity();
      const row = { ...original, $attributes: { ...original.$attributes, [key]: str('other') } };
      expect(() => decodeWalletProfile(row, 1, 2)).toThrow();
    }
  });
});
