import { decodeFunctionData, parseAbi, type Hex } from 'viem';
import type { UnsignedTransactionRequest } from '@privy-io/react-auth';
const ENGINE = '0x4400000000000000000000000000000000000044';
const ABI = parseAbi(['function execute((uint8 operation,bytes operationData)[] ops) external returns(bytes32[] keys)']);

/** Only zero-value native data operations use sponsored, one-click signing. */
export function arkivWalletTransaction(input: unknown, signer: string) {
  if (!input || typeof input !== 'object') throw new Error('Invalid Arkiv transaction.');
  const tx = input as Record<string, unknown>;
  if (typeof tx.to !== 'string' || tx.to.toLowerCase() !== ENGINE || typeof tx.from !== 'string'
    || tx.from.toLowerCase() !== signer.toLowerCase() || BigInt(String(tx.value ?? 0)) !== 0n
    || (tx.chainId !== undefined && Number(tx.chainId) !== 7794095) || typeof tx.data !== 'string') {
    throw new Error('This action must be a zero-value Arkiv data transaction from your wallet.');
  }
  const decoded = decodeFunctionData({ abi: ABI, data: tx.data as Hex });
  const ops = decoded.args![0];
  if (!ops.length || ops.some(op => ![1, 2, 5].includes(op.operation))) throw new Error('Unsupported Arkiv data operation.');
  const transaction: UnsignedTransactionRequest = { from: signer, to: ENGINE, value: '0x0', data: tx.data, chainId: 7794095 };
  for (const [source, target] of [['gas', 'gasLimit'], ['gasPrice', 'gasPrice'], ['nonce', 'nonce'],
    ['maxFeePerGas', 'maxFeePerGas'], ['maxPriorityFeePerGas', 'maxPriorityFeePerGas']] as const) {
    if (tx[source] !== undefined) {
      const quantity = String(tx[source]);
      if (!/^(0x[0-9a-f]+|[0-9]+)$/i.test(quantity)) throw new Error('Invalid transaction quantity.');
      transaction[target] = quantity;
    }
  }
  return { transaction, showWalletUIs: ops.some(op => op.operation === 5) };
}
