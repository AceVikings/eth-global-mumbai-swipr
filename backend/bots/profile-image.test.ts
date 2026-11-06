import { expect, it } from 'vitest';
import { bytes, str } from '@arkiv-network/sdk/schema';
import type { FullEntity } from '@arkiv-network/sdk';
import { decodeAbiParameters, decodeFunctionData, hexToString, parseAbiParameters } from 'viem';
import { profileImage } from '../contracts/profile-image';
import { WALLET_PROFILE_PROJECT, WALLET_PROFILE_SCHEMA } from '../contracts/wallet-profile';
import { profileUpsert } from './validation';
import { decodeWalletProfile } from './wallet-directory';
import { ARKIV_EXECUTE_ABI, buildWalletAction } from './wallet-actions';
const image = 'data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89WAAAAA==';
const wallet = `0x${'12'.repeat(20)}`, key = `0x${'ab'.repeat(32)}`;
const data = { operator: wallet, name: 'My bot', bio: '', style: 'Balanced', strategy: 'manual', assets: ['WETH'], image };
it('preserves a thumbnail through unsigned preparation and native Arkiv decoding', () => {
  const result = buildWalletAction({ wallet, action: 'profile.upsert', data }, []);
  const decoded = decodeFunctionData({ abi: ARKIV_EXECUTE_ABI, data: result.transaction.data });
  const [op] = decoded.args![0];
  const [create] = decodeAbiParameters(parseAbiParameters('(uint128 salt,uint64 expiresAt,uint64 minLifetime,uint8 creationFlags,(bytes32 name,uint8 typeId,bytes value)[] attributes)'), op.operationData);
  const attr = create.attributes.find(a => hexToString(a.name, { size: 32 }) === 'profile')!;
  const stored = JSON.parse(hexToString(attr.value));
  expect(stored.image).toBe(image);
  const entity = { $key: key, $owner: wallet, $attributes: {
    'arkiv.schema': str(WALLET_PROFILE_SCHEMA), project: str(WALLET_PROFILE_PROJECT),
    profile: bytes(new TextEncoder().encode(JSON.stringify(stored))), status: str('active'),
  } } as unknown as FullEntity;
  expect(decodeWalletProfile(entity, 1, 2)).toMatchObject({ image, owner: wallet });
});
it('rejects remote URLs, active content, invalid data and oversized thumbnails', () => {
  for (const bad of ['https://example.com/photo.webp', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/webp;base64,AAAA', `${image}${'A'.repeat(17000)}`, null]) {
    expect(() => profileUpsert({ ...data, profileId: '00000000-0000-4000-8000-000000000001', image: bad })).toThrow();
  }
});
it('supports removing an image and older profiles without images', () => {
  expect(profileImage('')).toBe('');
  const profileId = '00000000-0000-4000-8000-000000000001';
  expect(profileUpsert({ ...data, profileId, image: '' }).image).toBe('');
  const { image: _, ...legacy } = data;
  expect(profileUpsert({ ...legacy, profileId })).not.toHaveProperty('image');
});
