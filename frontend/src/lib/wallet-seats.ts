import { ExpirationTime } from '@arkiv-network/sdk';
import type { Hex } from 'viem';
import type { Session } from '../auth/Session';
import type { Terms } from '../contracts/types';
import { ENTITY_KEY } from '../contracts/passes';
import { parseSeatJoin, parseInviteTarget, type SeatDirectory, type SeatType } from '../contracts/seats';
import { WalletSeatSchema, WalletSeatInviteSchema, WALLET_PROFILE_PROJECT, walletJson } from '../contracts/wallet-profile';
import { accountRequest, arkivConnection, fundArkivWrite } from './arkiv';
export async function readSeats(session: Session): Promise<SeatDirectory> {
  if (!session.address) throw new Error('Sign in to view your seats.');
  const value = await accountRequest(session, `/api/seats?wallet=${session.address}`) as SeatDirectory;
  if (!Array.isArray(value.passes) || !Array.isArray(value.availability) || !Array.isArray(value.invitations)) throw new Error('Seats could not be loaded.');
  for (const pass of value.passes) {
    parseSeatJoin({ traderId: pass.traderId, traderOwner: pass.traderOwner, terms: pass.terms, seatType: pass.seatType, budgetVersion: pass.budgetVersion });
    if (!ENTITY_KEY.test(pass.id) || ![pass.owner.toLowerCase(), pass.traderOwner.toLowerCase()].includes(session.address.toLowerCase())) throw new Error('Invalid seat ownership.');
  }
  return value;
}
async function indexed(session: Session, match: (directory: SeatDirectory) => boolean) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const directory = await readSeats(session);
    if (match(directory)) return directory;
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  throw new Error('Transaction confirmed. Refresh shortly to see the updated seats.');
}
export async function joinSeat(session: Session, traderId: string, terms: Terms, seatType: SeatType) {
  const directory = await readSeats(session);
  const pool = directory.availability.find(p => p.traderId === traderId);
  if (!pool?.active || !session.address) throw new Error('This trader is not accepting copiers.');
  if (pool.traderOwner === session.address.toLowerCase()) throw new Error('Choose another wallet’s trader to copy.');
  if (directory.passes.some(p => p.owner === session.address!.toLowerCase() && p.traderId === traderId && p.status === 'joined')) throw new Error('You already have a seat with this trader.');
  if (seatType === 'private' && !pool.invited) throw new Error('Private seats require an invitation from this trader.');
  if (seatType === 'public' ? pool.publicUsed >= pool.publicSeats : pool.privateUsed >= pool.privateSeats) throw new Error('These seats are full.');
  const join = parseSeatJoin({ traderId, traderOwner: pool.traderOwner, terms, seatType, budgetVersion: 1 });
  const { client, address } = await arkivConnection(session);
  if (address.toLowerCase() !== session.address.toLowerCase()) throw new Error('Your account changed.');
  await fundArkivWrite(session, address);
  const result = await client.createEntity(WalletSeatSchema, { project: WALLET_PROFILE_PROJECT, join: walletJson(join) },
    { expiration: ExpirationTime.fromDays(90), flags: { readonly: true } });
  await client.waitForTransactionReceipt({ hash: result.txHash, confirmations: 2 });
  const saved = await indexed(session, d => d.passes.some(p => p.id === result.entityKey));
  const pass = saved.passes.find(p => p.id === result.entityKey)!;
  if (pass.status !== 'joined') throw new Error(pass.status === 'full' ? 'Another copier took the last seat first. You are on the waitlist.' : 'This seat is not available.');
  return pass;
}
export async function leaveSeat(session: Session, id: string) {
  const current = (await readSeats(session)).passes.find(p => p.id === id);
  if (!current || current.owner !== session.address?.toLowerCase()) throw new Error('Your wallet does not own this seat.');
  if(current.terms.mode==='auto') await (await import('./automation')).stopAutomation(session,id);
  const { client, reader, address } = await arkivConnection(session);
  const native = await reader.getEntity(id as Hex);
  if (native.$owner.toLowerCase() !== address.toLowerCase()) throw new Error('Your wallet does not own this seat.');
  await fundArkivWrite(session, address);
  const result = await client.deleteEntity({ entityKey: id as Hex });
  await client.waitForTransactionReceipt({ hash: result.txHash, confirmations: 2 });
  return indexed(session, d => !d.passes.some(p => p.id === id));
}
export async function inviteFriend(session: Session, traderId: string, wallet: string) {
  const target = parseInviteTarget(traderId, wallet);
  const current = await readSeats(session);
  const profile = current.availability.find(p => p.traderId === target.traderId && p.traderOwner === session.address?.toLowerCase());
  if (!profile) throw new Error('Only the trader wallet can invite friends.');
  if (profile.privateSeats === 0) throw new Error('Add private seats to your profile first.');
  if (current.invitations.some(i => i.traderId === target.traderId && i.wallet === target.wallet && i.status === 'active')) return current;
  const { client, reader, address } = await arkivConnection(session);
  if ((await reader.getEntity(target.traderId as Hex)).$owner.toLowerCase() !== address.toLowerCase()) throw new Error('Trader ownership changed.');
  await fundArkivWrite(session, address);
  const result = await client.createEntity(WalletSeatInviteSchema, { project: WALLET_PROFILE_PROJECT, profileId: target.traderId, invitee: target.wallet, status: 'active' }, { expiration: ExpirationTime.fromDays(90) });
  await client.waitForTransactionReceipt({ hash: result.txHash, confirmations: 2 });
  return indexed(session, d => d.invitations.some(i => i.entityKey === result.entityKey));
}
export async function revokeFriend(session: Session, entityKey: string) {
  const current = await readSeats(session);
  const invite = current.invitations.find(i => i.entityKey === entityKey && i.traderOwner === session.address?.toLowerCase());
  if (!invite) throw new Error('Your wallet does not own this invitation.');
  const { client, reader, address } = await arkivConnection(session);
  if ((await reader.getEntity(entityKey as Hex)).$owner.toLowerCase() !== address.toLowerCase()) throw new Error('Invitation ownership changed.');
  await fundArkivWrite(session, address);
  const result = await client.patchEntity(WalletSeatInviteSchema, entityKey as Hex, { set: { status: 'revoked' } });
  await client.waitForTransactionReceipt({ hash: result.txHash, confirmations: 2 });
  return indexed(session, d => d.invitations.some(i => i.entityKey === entityKey && i.status === 'revoked'));
}
