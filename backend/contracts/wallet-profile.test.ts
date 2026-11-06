import { expect, it } from 'vitest';
import { hexToString } from 'viem';
import { walletJson } from './wallet-profile';

it('stores complete profiles and following lists beyond Arkiv’s 128-byte text limit', () => {
  for (const value of [
    { name: 'A real wallet-owned profile', bio: 'x'.repeat(280), operator: `0x${'12'.repeat(20)}` },
    Array.from({ length: 200 }, (_, n) => `0x${n.toString(16).padStart(40, '0')}`),
  ]) {
    const encoded = walletJson(value);
    expect(encoded.type).toBe('bytes');
    expect(JSON.parse(hexToString(encoded.value))).toEqual(value);
    expect(encoded.value.length).toBeGreaterThan(258);
  }
});
