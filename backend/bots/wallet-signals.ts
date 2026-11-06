import { createPublicClient, type FullEntity } from '@arkiv-network/sdk';
import { rabdi } from '@arkiv-network/sdk/chains';
import { and, eq, desc } from '@arkiv-network/sdk/query';
import { str } from '@arkiv-network/sdk/schema';
import { http, hexToString, type Hex } from 'viem';
import { WALLET_PROFILE_PROJECT, WALLET_SIGNAL_SCHEMA } from '../contracts/wallet-profile';
import type { BotProfile, BotSignal } from '../contracts/bots';
import { address, signalPublish } from './validation';

export function decodeWalletSignal(entity: FullEntity, profiles: BotProfile[], timestamp: number): BotSignal {
  const a = entity.$attributes;
  if (a['arkiv.schema']?.value !== WALLET_SIGNAL_SCHEMA || a.project?.value !== WALLET_PROFILE_PROJECT
    || a.signal?.type !== 'bytes' || a.profileId?.type !== 'str') throw new Error('Invalid signal record.');
  const raw = JSON.parse(hexToString(a.signal.value as Hex));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.profileId !== a.profileId.value) throw new Error('Invalid signal profile.');
  const profile = profiles.find(p => p.id === raw.profileId);
  if (!profile || profile.status !== 'active' || profile.operator.toLowerCase() !== entity.$owner.toLowerCase()) throw new Error('Operator is not authorized.');
  const normalized = signalPublish({ ...raw, profileId: '00000000-0000-4000-8000-000000000001' });
  if (!profile.assets.includes(normalized.asset)) throw new Error('Asset is not enabled.');
  return { ...normalized, profileId: profile.id, id: entity.$key, operator: address(entity.$owner, 'operator'),
    kind: 'proposal', createdAt: new Date(timestamp * 1000).toISOString() };
}

export function createWalletSignals(options: { accessKey?: string; rpcUrl?: string }) {
  const client = createPublicClient({ chain: rabdi({ accessKey: options.accessKey || '' }), transport: http(options.rpcUrl, { retryCount: 0, timeout: 10000 }) });
  return async (profiles: BotProfile[]): Promise<BotSignal[]> => {
    if (!profiles.length) return [];
    if (await client.getChainId() !== 7794095) throw new Error('Wrong Arkiv network.');
    const head = await client.getBlockNumber({ cacheTime: 0 });
    const result = await client.query(and(eq('arkiv.schema', str(WALLET_SIGNAL_SCHEMA)), eq('project', str(WALLET_PROFILE_PROJECT))),
      { limit: 200, orderBy: desc('$key') });
    const signals: BotSignal[] = [];
    const times = new Map<bigint, number>();
    for (const entity of result.entities) {
      if (entity.$expiresAt <= head || entity.$createdAt > head - 1n || entity.$updatedAt > head - 1n) continue;
      if (!times.has(entity.$createdAt)) times.set(entity.$createdAt, Number((await client.getBlock({ blockNumber: entity.$createdAt })).timestamp));
      try { signals.push(decodeWalletSignal(entity, profiles, times.get(entity.$createdAt)!)); }
      catch { /* A copied public schema or unregistered operator does not authorize a proposal. */ }
    }
    return signals.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  };
}
