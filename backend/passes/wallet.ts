import { createPublicClient, type FullEntity } from '@arkiv-network/sdk';
import { rabdi } from '@arkiv-network/sdk/chains';
import { and, eq } from '@arkiv-network/sdk/query';
import { str } from '@arkiv-network/sdk/schema';
import { http, hexToString, type Hex } from 'viem';
import { WALLET_PROFILE_PROJECT, WALLET_PASS_SCHEMA, WALLET_PASS_DECISION_SCHEMA } from '../contracts/wallet-profile';
import { parsePassRequest, parsePassDecision, passRequestHash, type WalletPass } from '../contracts/passes';
import type { BotProfile } from '../contracts/bots';

const payload = (entity: FullEntity, field: string) => {
  const a = entity.$attributes[field];
  if (a?.type !== 'bytes') throw new Error('Invalid pass payload.');
  return JSON.parse(hexToString(a.value as Hex));
};
/** Both sides own their own records. An acceptance commits to the exact request contents. */
export function resolveWalletPasses(requests: FullEntity[], decisions: FullEntity[], profiles: BotProfile[],
  times: Map<bigint, number>, wallet: string, now: number): WalletPass[] {
  const result: WalletPass[] = [];
  for (const entity of requests) {
    try {
      if (entity.$attributes['arkiv.schema']?.value !== WALLET_PASS_SCHEMA
        || entity.$attributes.project?.value !== WALLET_PROFILE_PROJECT) continue;
      const request = parsePassRequest(payload(entity, 'request'));
      const owner = entity.$owner.toLowerCase();
      if (owner !== wallet && request.traderOwner !== wallet) continue;
      const profile = profiles.find(p => p.id === request.traderId && p.owner.toLowerCase() === request.traderOwner);
      if (!profile || owner === request.traderOwner) continue;
      const status = entity.$attributes.status?.value;
      if (!['pending', 'cancelled'].includes(String(status))) continue;
      const requestHash = passRequestHash(request);
      const answers = decisions.flatMap(answer => {
        try {
          if (answer.$attributes['arkiv.schema']?.value !== WALLET_PASS_DECISION_SCHEMA
            || answer.$attributes.project?.value !== WALLET_PROFILE_PROJECT
            || answer.$owner.toLowerCase() !== request.traderOwner
            || answer.$attributes.requestId?.value !== entity.$key) return [];
          const decision = parsePassDecision(payload(answer, 'decision'));
          if (decision.requestId !== entity.$key || decision.requestHash !== requestHash) return [];
          return [{ decision: decision.decision, at: times.get(answer.$createdAt)!, block: answer.$createdAt, key: answer.$key }];
        } catch { return []; }
      }).filter(a => Number.isSafeInteger(a.at)).sort((a, b) => a.block < b.block ? -1 : a.block > b.block ? 1 : a.key.localeCompare(b.key));
      // First response freezes the outcome. A later end can revoke acceptance, never restart it.
      const first = answers[0];
      const acceptedAt = first?.decision === 'accepted' ? first.at : null;
      const expiresAt = acceptedAt === null ? null : acceptedAt + request.terms.durationDays * 86400000;
      let state: WalletPass['status'] = first?.decision ?? 'pending';
      if (state === 'accepted' && answers.some(a => a.decision === 'ended')) state = 'ended';
      if (state === 'accepted' && expiresAt! <= now) state = 'expired';
      if (status === 'cancelled') state = 'cancelled';
      if (profile.status !== 'active' && state === 'accepted') state = 'ended';
      result.push({ ...request, traderName: profile.name, id: entity.$key, owner, requestHash, requestedAt: times.get(entity.$createdAt)!, acceptedAt, expiresAt, status: state });
    } catch { /* Public schemas can contain invalid records. */ }
  }
  return result.sort((a, b) => b.requestedAt - a.requestedAt);
}
export function createWalletPasses(options: { accessKey?: string; rpcUrl?: string }) {
  const client = createPublicClient({ chain: rabdi({ accessKey: options.accessKey || '' }), transport: http(options.rpcUrl, { retryCount: 0, timeout: 10000 }) });
  return async (wallet: string, profiles: BotProfile[]) => {
    if (await client.getChainId() !== 7794095) throw new Error('Wrong pass storage network.');
    const head = await client.getBlockNumber({ cacheTime: 0 });
    const read = async (schema: string) => {
      const entities: FullEntity[] = [];
      for (let offset = 0; offset < 1000; offset += 100) {
        const page = await client.query(and(eq('arkiv.schema', str(schema)), eq('project', str(WALLET_PROFILE_PROJECT))), { limit: 100, offset });
        entities.push(...page.entities.filter(e => e.$expiresAt > head && e.$updatedAt <= head - 1n));
        if (page.entities.length < 100) return entities;
      }
      throw new Error('Pass directory exceeds the supported limit.');
    };
    const [requests, decisions] = await Promise.all([read(WALLET_PASS_SCHEMA), read(WALLET_PASS_DECISION_SCHEMA)]);
    const times = new Map<bigint, number>();
    for (const e of [...requests, ...decisions]) if (!times.has(e.$createdAt)) {
      times.set(e.$createdAt, Number((await client.getBlock({ blockNumber: e.$createdAt })).timestamp) * 1000);
    }
    return resolveWalletPasses(requests, decisions, profiles, times, wallet.toLowerCase(), Number((await client.getBlock({ blockNumber: head })).timestamp) * 1000);
  };
}
