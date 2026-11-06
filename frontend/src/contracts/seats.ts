import { keccak256, stringToHex } from 'viem';
import { ENTITY_KEY, parsePassRequest } from './passes';
import type { Terms } from './types';
export type SeatType = 'public' | 'private';
export type SeatJoin = { traderId: string; traderOwner: string; seatType: SeatType; terms: Terms };
export type SeatPass = SeatJoin & { id: string; owner: string; traderName: string; joinedAt: number; expiresAt: number;
  status: 'joined' | 'full' | 'not_invited' | 'expired' | 'halted' | 'duplicate'; seatNumber: number | null };
export type SeatInvite = { entityKey: string; traderId: string; traderOwner: string; traderName: string; wallet: string; status: 'active' | 'revoked' };
export type SeatAvailability = { traderId: string; traderOwner: string; traderName: string; publicSeats: number; privateSeats: number;
  publicUsed: number; privateUsed: number; invited: boolean; active: boolean };
export type SeatDirectory = { passes: SeatPass[]; invitations: SeatInvite[]; availability: SeatAvailability[] };
export function parseSeatJoin(value: unknown): SeatJoin {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid seat join.');
  const r = value as Record<string, unknown>;
  if (Object.keys(r).some(k => !['traderId', 'traderOwner', 'seatType', 'terms'].includes(k)) || !['public', 'private'].includes(String(r.seatType))) throw new Error('Choose a public or private seat.');
  return { ...parsePassRequest({ traderId: r.traderId, traderOwner: r.traderOwner, terms: r.terms }), seatType: r.seatType as SeatType };
}
export const seatJoinHash = (join: SeatJoin) => keccak256(stringToHex(JSON.stringify(parseSeatJoin(join))));
export function parseInviteTarget(traderId: unknown, wallet: unknown) {
  if (typeof traderId !== 'string' || !ENTITY_KEY.test(traderId) || typeof wallet !== 'string'
    || !/^0x[0-9a-f]{40}$/i.test(wallet) || /^0x0{40}$/i.test(wallet)) throw new Error('Choose a trader and a valid friend wallet.');
  return { traderId: traderId.toLowerCase(), wallet: wallet.toLowerCase() };
}
