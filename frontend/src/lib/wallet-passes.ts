import { ExpirationTime } from '@arkiv-network/sdk';
import type { Hex } from 'viem';
import type { Session } from '../auth/Session';
import type { Terms, Trader } from '../contracts/types';
import { parsePassRequest, passRequestHash, type PassDecision, type WalletPass } from '../contracts/passes';
import { WalletPassSchema, WalletPassDecisionSchema, WALLET_PROFILE_PROJECT, walletJson } from '../contracts/wallet-profile';
import { accountRequest, arkivConnection, fundArkivWrite } from './arkiv';
export async function readWalletPasses(session: Session): Promise<WalletPass[]> {
  if (!session.address) throw new Error('Sign in to view your matches.');
  const response = await accountRequest(session, `/api/passes?wallet=${session.address}`);
  if (!Array.isArray(response.passes)) throw new Error('Your passes could not be loaded.');
  return response.passes.map((p: WalletPass) => {
    const request = parsePassRequest({ traderId: p.traderId, traderOwner: p.traderOwner, terms: p.terms });
    if (passRequestHash(request) !== p.requestHash || !/^0x[0-9a-f]{64}$/i.test(p.id)
      || (p.owner.toLowerCase() !== session.address!.toLowerCase() && p.traderOwner !== session.address!.toLowerCase())) throw new Error('Invalid pass record.');
    return { ...p, ...request };
  });
}
async function indexed(session: Session, match: (passes: WalletPass[]) => boolean) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const passes = await readWalletPasses(session);
    if (match(passes)) return passes;
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  throw new Error('Transaction confirmed. Refresh shortly for the updated pass.');
}
export async function requestWalletPass(session: Session, trader: Trader, terms: Terms) {
  const request = parsePassRequest({ traderId: trader.id, traderOwner: trader.owner, terms });
  if (!session.address) throw new Error('Sign in to request a pass.');
  if (session.address.toLowerCase() === request.traderOwner) throw new Error('Choose another wallet’s trader to copy.');
  const existing = await readWalletPasses(session);
  if (existing.some(p => p.owner === session.address!.toLowerCase() && p.traderId === request.traderId && ['pending', 'accepted'].includes(p.status))) throw new Error('You already have a pending or accepted pass with this trader.');
  const { client, address } = await arkivConnection(session);
  if (address.toLowerCase() !== session.address.toLowerCase()) throw new Error('Your account changed. Try again.');
  await fundArkivWrite(session, address);
  const result = await client.createEntity(WalletPassSchema, { project: WALLET_PROFILE_PROJECT, request: walletJson(request), status: 'pending' }, { expiration: ExpirationTime.fromDays(90) });
  await client.waitForTransactionReceipt({ hash: result.txHash, confirmations: 2 });
  await indexed(session, passes => passes.some(p => p.id === result.entityKey));
  return result.entityKey;
}
export async function respondWalletPass(session: Session, id: string, action: PassDecision['decision'] | 'cancelled') {
  const current = (await readWalletPasses(session)).find(p => p.id === id);
  if (!current || !session.address) throw new Error('This pass is no longer available.');
  const isCopier = session.address.toLowerCase() === current.owner;
  if (action === 'cancelled' ? !isCopier : session.address.toLowerCase() !== current.traderOwner) throw new Error('Your wallet cannot change this pass.');
  if (['accepted', 'declined'].includes(action) && current.status !== 'pending') throw new Error('This request has already been answered.');
  if (action === 'ended' && current.status !== 'accepted') throw new Error('This pass is not accepted.');
  if (action === 'cancelled' && !['pending', 'accepted'].includes(current.status)) throw new Error('This pass has already ended.');
  const { client, reader, address } = await arkivConnection(session);
  if (address.toLowerCase() !== session.address.toLowerCase()) throw new Error('Your account changed. Try again.');
  // Confirm ownership again directly before a patch; acceptance is a separate trader-owned entity.
  const native = await reader.getEntity(id as Hex);
  if (native.$owner.toLowerCase() !== current.owner) throw new Error('Pass ownership changed.');
  await fundArkivWrite(session, address);
  const result = action === 'cancelled'
    ? await client.patchEntity(WalletPassSchema, id as Hex, { set: { status: 'cancelled' } })
    : await client.createEntity(WalletPassDecisionSchema, { project: WALLET_PROFILE_PROJECT, requestId: id,
      decision: walletJson({ requestId: id, requestHash: current.requestHash, decision: action }) }, { expiration: ExpirationTime.fromDays(90) });
  await client.waitForTransactionReceipt({ hash: result.txHash, confirmations: 2 });
  return indexed(session, passes => passes.some(p => p.id === id && p.status === action));
}
