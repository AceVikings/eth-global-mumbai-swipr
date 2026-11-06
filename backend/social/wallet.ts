import { createPublicClient } from '@arkiv-network/sdk';
import { rabdi } from '@arkiv-network/sdk/chains';
import { and, eq } from '@arkiv-network/sdk/query';
import { str, addr } from '@arkiv-network/sdk/schema';
import { http, isAddress, hexToString, type Hex } from 'viem';
import { WALLET_PROFILE_PROJECT, WALLET_SOCIAL_SCHEMA } from '../contracts/wallet-profile';

export function createWalletSocial(options: { accessKey?: string; rpcUrl?: string }) {
  const client = createPublicClient({ chain: rabdi({ accessKey: options.accessKey || '' }), transport: http(options.rpcUrl) });
  return async (wallet: string) => {
    if (await client.getChainId() !== 7794095) throw new Error('Wrong account storage chain');
    const result = await client.query(and(eq('arkiv.schema', str(WALLET_SOCIAL_SCHEMA)),
      eq('project', str(WALLET_PROFILE_PROJECT)), eq('$owner', addr(wallet))), { limit: 100 });
    if (result.entities.length >= 100) throw new Error('Too many social records');
    const record = result.entities.sort((a, b) => Number(b.$updatedAt - a.$updatedAt) || a.$key.localeCompare(b.$key))[0];
    if (!record) return { entityKey: null, following: [] as string[] };
    const following: unknown = JSON.parse(hexToString(record.$attributes.following?.value as Hex));
    if (!Array.isArray(following) || following.length > 200 || !following.every(a => typeof a === 'string' && isAddress(a))) throw new Error('Invalid wallet-owned social data');
    return { entityKey: record.$key, following: [...new Set(following.map(a => a.toLowerCase()))] };
  };
}
