import { createPublicClient, type FullEntity } from '@arkiv-network/sdk';
import { rabdi } from '@arkiv-network/sdk/chains';
import { and, eq, desc } from '@arkiv-network/sdk/query';
import { str } from '@arkiv-network/sdk/schema';
import { http } from 'viem';
import { WALLET_PROFILE_SCHEMA, WALLET_PROFILE_PROJECT } from '../arkiv-profile';
import type { BotProfile } from '../../shared/bots';
import { address, profileUpsert } from './validation';

/** Native chain metadata supplies ownership, identity and timestamps, never JSON claims. */
export function decodeWalletProfile(entity: FullEntity, createdAt: number, updatedAt: number): BotProfile {
  const attrs = entity.$attributes;
  if (attrs['arkiv.schema']?.value !== WALLET_PROFILE_SCHEMA || attrs.project?.value !== WALLET_PROFILE_PROJECT
    || attrs.profile?.type !== 'str' || attrs.status?.type !== 'str'
    || !['active', 'halted'].includes(attrs.status.value)
    || !/^0x[0-9a-f]{64}$/i.test(entity.$key)) throw new Error('Invalid wallet profile entity.');
  const raw: unknown = JSON.parse(attrs.profile.value);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || 'profileId' in raw) throw new Error('Invalid wallet profile contents.');
  // Reuse the registry's field/secret validation; the native entity key is the actual ID.
  const { profileId: _, ...data } = profileUpsert({ ...raw, profileId: '00000000-0000-4000-8000-000000000001' });
  return {
    ...data, id: entity.$key, owner: address(entity.$owner, 'owner'), storage: 'wallet',
    status: attrs.status.value as 'active' | 'halted',
    createdAt: new Date(createdAt * 1000).toISOString(), updatedAt: new Date(updatedAt * 1000).toISOString(),
  };
}

/** Read-only directory. No service writer key is needed to discover user-owned entities. */
export function createWalletDirectory(options: { accessKey?: string; rpcUrl?: string }) {
  const client = createPublicClient({ chain: rabdi({ accessKey: options.accessKey || '' }),
    transport: http(options.rpcUrl, { retryCount: 0, timeout: 10000 }) });
  return async (): Promise<BotProfile[]> => {
    if (await client.getChainId() !== 7794095) throw new Error('Wrong Arkiv network.');
    const profiles: BotProfile[] = [];
    const timestamps = new Map<bigint, number>();
    const time = async (blockNumber: bigint) => {
      if (!timestamps.has(blockNumber)) timestamps.set(blockNumber, Number((await client.getBlock({ blockNumber })).timestamp));
      return timestamps.get(blockNumber)!;
    };
    const head = await client.getBlockNumber();
    // Bound work per request. Expired entities are already excluded by Arkiv's query surface.
    for (let offset = 0; offset < 500; offset += 100) {
      const result = await client.query(and(eq('arkiv.schema', str(WALLET_PROFILE_SCHEMA)),
        eq('project', str(WALLET_PROFILE_PROJECT))), { limit: 100, offset, orderBy: desc('$key') });
      for (const entity of result.entities) {
        if (entity.$expiresAt <= head || entity.$createdAt > head - 1n || entity.$updatedAt > head - 1n) continue;
        const createdAt = await time(entity.$createdAt), updatedAt = await time(entity.$updatedAt);
        try {
          profiles.push(decodeWalletProfile(entity, createdAt, updatedAt));
        } catch {
          // Public schemas can be copied by anyone; invalid contents never enter the directory.
        }
      }
      if (result.entities.length < 100) break;
    }
    return profiles.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  };
}
