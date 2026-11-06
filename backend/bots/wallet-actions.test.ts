import { describe, it, expect } from 'vitest';
import { decodeAbiParameters, decodeFunctionData, hexToString, parseAbiParameters } from 'viem';
import { buildWalletAction, ARKIV_EXECUTE_ABI } from './wallet-actions';
const wallet = `0x${'12'.repeat(20)}`;
const id = `0x${'ab'.repeat(32)}`;
const profile = { id, owner: wallet, operator: wallet, name: 'My trader', bio: '', style: 'Balanced' as const,
  strategy: 'manual' as const, assets: ['WETH' as const], status: 'active' as const, createdAt: '', updatedAt: '' };
const data = { profileId: id, asset: 'WETH', side: 'buy', quantity: '0.01', limitPrice: '3000' };

describe('wallet-native bot transactions', () => {
  it('prepares an unsigned operator-owned signal transaction, without moving tokens', () => {
    const result = buildWalletAction({ wallet, action: 'signal.publish', data }, [profile]);
    expect(result.transaction).toMatchObject({ from: wallet, to: '0x4400000000000000000000000000000000000044', value: '0x0', chainId: '0x76edaf' });
    expect(result).toMatchObject({ requiresWalletApproval: true, kind: 'proposal' });
    const decoded = decodeFunctionData({ abi: ARKIV_EXECUTE_ABI, data: result.transaction.data });
    const op = decoded.args![0][0];
    expect(op.operation).toBe(1);
    const [create] = decodeAbiParameters(parseAbiParameters('(uint128 salt,uint64 expiresAt,uint64 minLifetime,uint8 creationFlags,(bytes32 name,uint8 typeId,bytes value)[] attributes)'), op.operationData);
    const fields = Object.fromEntries(create.attributes.map(a => [hexToString(a.name, { size: 32 }), a]));
    expect(create.minLifetime).toBe(1296000n);
    expect(fields.signal.typeId).toBe(7);
    expect(JSON.parse(hexToString(fields.signal.value))).toMatchObject(data);
    expect(hexToString(fields['arkiv.schema'].value)).toBe('swipr.wallet-signal.v1');
  });
  it('rejects an unrelated operator, halted profile and unsupported asset', () => {
    expect(() => buildWalletAction({ wallet: `0x${'34'.repeat(20)}`, action: 'signal.publish', data }, [profile])).toThrow();
    expect(() => buildWalletAction({ wallet, action: 'signal.publish', data }, [{ ...profile, status: 'halted' }])).toThrow();
    expect(() => buildWalletAction({ wallet, action: 'signal.publish', data: { ...data, asset: 'cbBTC' } }, [profile])).toThrow();
  });
  it('only lets native owners edit/halt, and cannot add authority or performance fields', () => {
    expect(() => buildWalletAction({ wallet: `0x${'34'.repeat(20)}`, action: 'profile.halt', data: { profileId: id } }, [profile])).toThrow();
    const draft = { name: 'New trader', operator: wallet, bio: '', style: 'Balanced', strategy: 'manual', assets: ['WETH'] };
    expect(() => buildWalletAction({ wallet, action: 'profile.upsert', data: { ...draft, profit: 30 } }, [])).toThrow();
    expect(buildWalletAction({ wallet, action: 'profile.upsert', data: draft }, []).transaction.value).toBe('0x0');
  });
});
