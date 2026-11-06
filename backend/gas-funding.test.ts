import { expect, it } from 'vitest';
import { fundingAmount, FUNDING } from './gas-funding';
import { parseEther } from 'viem';

it('funds only a gas-short wallet, up to the target balance', () => {
  expect(fundingAmount(FUNDING.threshold, 0n)).toBe(0n);
  expect(fundingAmount(parseEther('0.0005'), 0n)).toBe(parseEther('0.0045'));
});
it('counts reserved transfers against the daily cap before a broadcast', () => {
  expect(() => fundingAmount(0n, parseEther('0.099'))).toThrow('budget');
  expect(fundingAmount(0n, parseEther('0.095'))).toBe(FUNDING.target);
});
