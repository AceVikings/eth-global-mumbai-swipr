import { createPublicClient, type FullEntity } from '@arkiv-network/sdk';
import { rabdi } from '@arkiv-network/sdk/chains';
import { and, eq } from '@arkiv-network/sdk/query';
import { str, addr } from '@arkiv-network/sdk/schema';
import { http, hexToString, type Hex } from 'viem';
import { WALLET_PROFILE_PROJECT, WALLET_GHOST_SCHEMA } from '../contracts/wallet-profile';
import { parseWalletGhost, type WalletGhostRecord } from '../contracts/ghosts';

export function decodeWalletGhost(entity: FullEntity, wallet: string): WalletGhostRecord {
  const a = entity.$attributes;
  if (entity.$owner.toLowerCase() !== wallet.toLowerCase() || !/^0x[0-9a-f]{64}$/i.test(entity.$key)
    || a['arkiv.schema']?.value !== WALLET_GHOST_SCHEMA || a.project?.value !== WALLET_PROFILE_PROJECT
    || a.ghost?.type !== 'bytes' || a.status?.type !== 'str' || !['active', 'removed'].includes(a.status.value)) {
    throw new Error('Invalid wallet-owned ghost.');
  }
  return { entityKey: entity.$key, status: a.status.value as 'active' | 'removed',
    ghost: parseWalletGhost(JSON.parse(hexToString(a.ghost.value as Hex))) };
}
export function createWalletGhosts(options: { accessKey?: string; rpcUrl?: string }) {
  const client = createPublicClient({ chain: rabdi({ accessKey: options.accessKey || '' }), transport: http(options.rpcUrl) });
  return async (wallet: string): Promise<WalletGhostRecord[]> => {
    if (await client.getChainId() !== 7794095) throw new Error('Wrong account storage chain.');
    const head = await client.getBlockNumber({ cacheTime: 0 });
    const records: WalletGhostRecord[] = [];
    for (let offset = 0; offset < 500; offset += 100) {
      const page = await client.query(and(eq('arkiv.schema', str(WALLET_GHOST_SCHEMA)),
        eq('project', str(WALLET_PROFILE_PROJECT)), eq('$owner', addr(wallet))), { limit: 100, offset });
      for (const entity of page.entities) {
        if (entity.$expiresAt <= head || entity.$updatedAt > head - 1n) continue;
        try { records.push(decodeWalletGhost(entity, wallet)); } catch { /* Ignore copied/invalid public schema records. */ }
      }
      if (page.entities.length < 100) return records;
    }
    throw new Error('Too many ghost records.');
  };
}
