import { describe, it, expect } from 'vitest';
import { encodeFunctionData, parseAbi } from 'viem';
import { arkivWalletTransaction } from './arkiv-transaction';
const owner = `0x${'12'.repeat(20)}`;
const abi = parseAbi(['function execute((uint8 operation,bytes operationData)[] ops) external returns(bytes32[] keys)']);
const tx = (operation = 1) => ({ from: owner, to: '0x4400000000000000000000000000000000000044', value: '0x0', gas: '0x40000',
  data: encodeFunctionData({ abi, functionName: 'execute', args: [[{ operation, operationData: '0x' }]] }) });
describe('sponsored embedded-wallet writes', () => {
  it('sets Rabdi explicitly and makes ordinary record saves headless', () => {
    const result = arkivWalletTransaction(tx(), owner);
    expect(result.transaction).toMatchObject({ chainId: 7794095, from: owner, value: '0x0', gasLimit: '0x40000' });
    expect(result.showWalletUIs).toBe(false);
  });
  it('retains a wallet confirmation for record deletion', () => {
    expect(arkivWalletTransaction(tx(5), owner).showWalletUIs).toBe(true);
  });
  it('rejects token transfers, other chains, other senders and ownership changes', () => {
    for (const patch of [{ to: owner }, { from: `0x${'34'.repeat(20)}` }, { chainId: 8453 }, { value: '0x1' }]) {
      expect(() => arkivWalletTransaction({ ...tx(), ...patch }, owner)).toThrow();
    }
    expect(() => arkivWalletTransaction(tx(4), owner)).toThrow();
  });
});
