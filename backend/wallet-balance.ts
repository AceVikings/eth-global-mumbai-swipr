import { createPublicClient, erc20Abi, http, type Address } from 'viem';
import { base } from 'viem/chains';
import { TOKENS } from './providers/flash';

export function displayUnits(value: bigint, decimals: number, places: number): string {
  const divisor = 10n ** BigInt(decimals);
  return `${(value / divisor).toLocaleString('en-US')}.${((value % divisor) / 10n ** BigInt(decimals - places)).toString().padStart(places, '0')}`;
}
export function createWalletBalance(rpcUrl: string) {
  const client = createPublicClient({ chain: base, transport: http(rpcUrl, { timeout: 8000, retryCount: 0 }) });
  return async (address: string) => {
    if (await client.getChainId() !== base.id) throw new Error('Balance network is unavailable.');
    const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
    const [eth, usdc] = await Promise.all([
      client.getBalance({ address: address as Address, blockNumber }),
      client.readContract({ address: TOKENS.USDC.address as Address, abi: erc20Abi, functionName: 'balanceOf', args: [address as Address], blockNumber }),
    ]);
    return { address, chainId: base.id, blockNumber: blockNumber.toString(), usdc: usdc.toString(), eth: eth.toString(),
      display: `${displayUnits(usdc, 6, 2)} USDC`, gasDisplay: `${displayUnits(eth, 18, 6)} ETH` };
  };
}
