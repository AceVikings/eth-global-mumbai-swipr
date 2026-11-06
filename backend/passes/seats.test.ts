import { describe, it, expect } from 'vitest';
import { str, bytes } from '@arkiv-network/sdk/schema';
import type { FullEntity } from '@arkiv-network/sdk';
import type { BotProfile } from '../contracts/bots';
import { DEFAULT_TERMS } from '../contracts/types';
import { WALLET_SEAT_SCHEMA, WALLET_SEAT_INVITE_SCHEMA, WALLET_PROFILE_PROJECT } from '../contracts/wallet-profile';
import { allocateSeats } from './seats';
const key = (n: string) => `0x${n.repeat(64)}` as `0x${string}`;
const address = (n: string) => `0x${n.repeat(40)}` as `0x${string}`;
const trader = address('1'), bob = address('2'), carol = address('3');
const profile = { id: key('a'), owner: trader, name: 'Real test trader', status: 'active', publicSeats: 1, privateSeats: 1 } as BotProfile;
const entity = (schema: string, owner: string, block: bigint, attrs: Record<string, unknown>, id: `0x${string}`) => ({
  $key: id, $owner: owner, $creator: owner, $createdAt: block, $updatedAt: block, $creationFlags: { readonly: true },
  $attributes: { 'arkiv.schema': str(schema), project: str(WALLET_PROFILE_PROJECT), ...attrs },
}) as unknown as FullEntity;
const join = (owner: string, block: bigint, seatType = 'public', id = key(String(block))) => entity(WALLET_SEAT_SCHEMA, owner, block,
  { join: bytes(new TextEncoder().encode(JSON.stringify({ traderId: profile.id, traderOwner: trader, seatType, terms: { ...DEFAULT_TERMS, durationDays: 1 } }))) }, id);
const invite = (wallet: string, owner = trader, status = 'active') => entity(WALLET_SEAT_INVITE_SCHEMA, owner, 1n,
  { profileId: str(profile.id), invitee: str(wallet), status: str(status) }, key('f'));
const times = new Map([[1n, 1700000000000], [2n, 1700000001000], [3n, 1700000002000]]);
const resolve = (rows: FullEntity[], invites: FullEntity[] = [], who = bob, now = 1700000005000) => allocateSeats(rows, invites, [profile], times, who, now);
describe('automatic public and private seats', () => {
  it('joins public seats immediately without a trader acceptance record', () => {
    expect(resolve([join(bob, 1n)]).passes[0]).toMatchObject({ status: 'joined', seatNumber: 1, owner: bob });
    expect(resolve([join(bob, 1n)]).availability[0]).toMatchObject({ publicUsed: 1, privateUsed: 0 });
  });
  it('allocates simultaneous joins deterministically without exceeding capacity', () => {
    const a = join(bob, 1n, 'public', key('b')), b = join(carol, 1n, 'public', key('c'));
    for (const rows of [[a, b], [b, a]]) {
      const state = resolve(rows, [], trader);
      expect(state.passes.filter(p => p.status === 'joined')).toHaveLength(1);
      expect(state.passes.find(p => p.owner === bob)?.status).toBe('joined');
      expect(state.passes.find(p => p.owner === carol)?.status).toBe('full');
    }
  });
  it('requires a native trader-created invitation for a private seat', () => {
    const row = join(bob, 1n, 'private');
    expect(resolve([row]).passes[0].status).toBe('not_invited');
    expect(resolve([row], [invite(bob, carol)]).passes[0].status).toBe('not_invited');
    expect(resolve([row], [invite(carol)]).passes[0].status).toBe('not_invited');
    expect(resolve([row], [invite(bob)]).passes[0].status).toBe('joined');
    expect(resolve([row], [invite(bob, trader, 'revoked')]).passes[0].status).toBe('not_invited');
    const spoof = { ...invite(bob), $creator: carol };
    expect(resolve([row], [spoof]).passes[0].status).toBe('not_invited');
  });
  it('keeps the public and private pools separate and rejects duplicate seats', () => {
    const result = resolve([join(bob, 1n), join(bob, 2n), join(carol, 3n, 'private')], [invite(carol)], trader);
    expect(result.passes.map(p => p.status)).toEqual(['joined', 'duplicate', 'joined']);
    expect(result.availability[0]).toMatchObject({ publicUsed: 1, privateUsed: 1 });
  });
  it('frees expired seats and rejects mutable or transferred joins', () => {
    const old = join(bob, 1n), next = join(carol, 3n);
    expect(resolve([old, next], [], carol, 1700000000000 + 86400001).passes[0].status).toBe('joined');
    expect(resolve([{ ...old, $creationFlags: { readonly: false } } as FullEntity]).passes).toEqual([]);
    expect(resolve([{ ...old, $creator: carol }]).passes).toEqual([]);
    expect(resolve([old], [], carol).passes).toEqual([]);
  });
});
