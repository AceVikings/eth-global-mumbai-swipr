import { createPublicClient, type FullEntity } from '@arkiv-network/sdk';
import { rabdi } from '@arkiv-network/sdk/chains';
import { and, eq, asc } from '@arkiv-network/sdk/query';
import { str } from '@arkiv-network/sdk/schema';
import { http, hexToString, type Hex } from 'viem';
import { WALLET_PROFILE_PROJECT, WALLET_SEAT_SCHEMA, WALLET_SEAT_INVITE_SCHEMA } from '../contracts/wallet-profile';
import { parseSeatJoin, parseInviteTarget, type SeatDirectory, type SeatPass, type SeatInvite } from '../contracts/seats';
import type { BotProfile } from '../contracts/bots';
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const valid = (e: FullEntity, schema: string) => e.$attributes['arkiv.schema']?.value === schema
  && e.$attributes.project?.value === WALLET_PROFILE_PROJECT && same(e.$creator, e.$owner);
/** One canonical ordering allocates a bounded pool. A simultaneous join can lose, never overbook. */
export function allocateSeats(entities: FullEntity[], invites: FullEntity[], profiles: BotProfile[],
  times: Map<bigint, number>, wallet: string, now: number): SeatDirectory {
  const invitations: SeatInvite[] = invites.flatMap(e => {
    try {
      if (!valid(e, WALLET_SEAT_INVITE_SCHEMA)) return [];
      const target = parseInviteTarget(e.$attributes.profileId?.value, e.$attributes.invitee?.value);
      const profile = profiles.find(p => p.id === target.traderId && same(p.owner, e.$owner));
      if (!profile || !['active', 'revoked'].includes(String(e.$attributes.status?.value))) return [];
      return [{ entityKey: e.$key, traderId: profile.id, traderOwner: profile.owner.toLowerCase(), traderName: profile.name,
        wallet: target.wallet, status: e.$attributes.status.value as SeatInvite['status'] }];
    } catch { return []; }
  });
  const availability = profiles.map(p => ({ traderId: p.id, traderOwner: p.owner.toLowerCase(), traderName: p.name,
    publicSeats: p.publicSeats ?? 20, privateSeats: p.privateSeats ?? 0, publicUsed: 0, privateUsed: 0,
    invited: invitations.some(i => i.traderId === p.id && i.wallet === wallet.toLowerCase() && i.status === 'active'), active: p.status === 'active' }));
  const seen = new Set<string>();
  const passes: SeatPass[] = [];
  // Immutable attributes cannot be backdated or changed to jump another trader's queue.
  for (const e of [...entities].sort((a, b) => a.$createdAt < b.$createdAt ? -1 : a.$createdAt > b.$createdAt ? 1 : a.$key.localeCompare(b.$key))) {
    try {
      if (!valid(e, WALLET_SEAT_SCHEMA) || !e.$creationFlags.readonly || e.$attributes.join?.type !== 'bytes') continue;
      const join = parseSeatJoin(JSON.parse(hexToString(e.$attributes.join.value as Hex)));
      const pool = availability.find(p => p.traderId === join.traderId && p.traderOwner === join.traderOwner);
      const joinedAt = times.get(e.$createdAt);
      if (!pool || !Number.isSafeInteger(joinedAt) || same(e.$owner, pool.traderOwner)) continue;
      const expiresAt = joinedAt! + join.terms.durationDays * 86400000;
      const pass: SeatPass = { ...join, id: e.$key, owner: e.$owner.toLowerCase(), traderName: pool.traderName,
        joinedAt: joinedAt!, expiresAt, seatNumber: null, status: 'joined' };
      const key = `${join.traderId}:${pass.owner}`;
      const invited = invitations.some(i => i.traderId === join.traderId && i.wallet === pass.owner && i.status === 'active');
      const used = join.seatType === 'public' ? 'publicUsed' : 'privateUsed';
      const capacity = join.seatType === 'public' ? pool.publicSeats : pool.privateSeats;
      if (expiresAt <= now) pass.status = 'expired';
      else if (!pool.active) pass.status = 'halted';
      else if (seen.has(key)) pass.status = 'duplicate';
      else if (join.seatType === 'private' && !invited) pass.status = 'not_invited';
      else if (pool[used] >= capacity) pass.status = 'full';
      else { pool[used]++; pass.seatNumber = pool[used]; seen.add(key); }
      passes.push(pass);
    } catch { /* A public schema alone never grants a seat. */ }
  }
  return { passes: passes.filter(p => same(p.owner, wallet) || same(p.traderOwner, wallet)),
    invitations: invitations.filter(i => same(i.wallet, wallet) || same(i.traderOwner, wallet)), availability };
}
export function createSeatDirectory(options: { accessKey?: string; rpcUrl?: string }) {
  const client = createPublicClient({ chain: rabdi({ accessKey: options.accessKey || '' }), transport: http(options.rpcUrl, { retryCount: 0, timeout: 10000 }) });
  return async (wallet: string, profiles: BotProfile[]) => {
    if (await client.getChainId() !== 7794095) throw new Error('Wrong seat storage network.');
    for (let attempt = 0; attempt < 4; attempt++) {
      const blocks = new Set<bigint>();
      const read = async (schema: string) => {
        const entities: FullEntity[] = [];
        for (let offset = 0; offset < 1000; offset += 100) {
          const page = await client.query(and(eq('arkiv.schema', str(schema)), eq('project', str(WALLET_PROFILE_PROJECT))), { limit: 100, offset, orderBy: asc('$key') });
          blocks.add(page.blockNumber); entities.push(...page.entities);
          if (page.entities.length < 100) return entities;
        }
        throw new Error('Seat directory exceeds the supported limit.');
      };
      const [joins, invites] = await Promise.all([read(WALLET_SEAT_SCHEMA), read(WALLET_SEAT_INVITE_SCHEMA)]);
      // Arkiv pagination reads latest state: never admit from mixed-block pages.
      if (blocks.size !== 1) continue;
      const head = [...blocks][0];
      const confirmed = (e: FullEntity) => e.$expiresAt > head && e.$updatedAt <= head - 1n;
      const records = [...joins, ...invites].filter(confirmed);
      const times = new Map<bigint, number>();
      for (const e of records) if (!times.has(e.$createdAt)) times.set(e.$createdAt, Number((await client.getBlock({ blockNumber: e.$createdAt })).timestamp) * 1000);
      return allocateSeats(joins.filter(confirmed), invites.filter(confirmed), profiles, times, wallet, Number((await client.getBlock({ blockNumber: head })).timestamp) * 1000);
    }
    throw new Error('Seats are changing. Refresh before joining.');
  };
}
