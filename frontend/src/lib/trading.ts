import type { Hex } from 'viem';
import type { Session } from '../auth/Session';
import { apiBase } from './bots';
export type TradeQuote = {
  ticket: string; quoteId: string; integratorFeeBps: string; expiresAt: number; estimatedFeeNotional: string | null;
  intent: { side: 'buy' | 'sell'; funder: string; asset: 'WETH' | 'cbBTC'; qty: string; sharedPrice: string };
  typedData: { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> };
  approval: null | { to: string; data: string; value: string; chainId: number };
};
export type TradeStatus = { copyAccountingPending?: boolean; orderId: string; status: string; unverifiedFills: number;
  fills: { txHash: string; asset: string; side: string; usdcMicros: string; assetUnits: string; price: string; confirmations: number }[] };
export type TradeHistory = { orders: TradeStatus[]; hasMore: boolean; scope: 'latest20Orders' };
export class TradeError extends Error { constructor(message: string, readonly uncertain = false) { super(message); } }
export async function tradeRequest<T>(session: Session, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const wallet = session.address;
  const token = await session.getAccessToken();
  if (!token || !wallet) throw new TradeError('Sign in to trade.');
  let response: Response;
  try { response = await fetch(`${apiBase}/api/trades/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify({ ...body as object, wallet }) }), cache: 'no-store', signal }); }
  catch { throw new TradeError(path === 'submit' ? 'Submission may have reached Flash. Check your order history before placing another trade.' : 'The trade service could not be reached.', path === 'submit'); }
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) throw new TradeError(result?.error?.message || 'The trade service is unavailable.', path === 'submit');
  return result as T;
}

/** Approvals and signatures are requested only from an explicit reviewed-order action. */
export async function sendReviewedTrade(session: Session, quote: TradeQuote, progress: (text: string) => void, signal: AbortSignal): Promise<{ orderId: string }> {
  const valid = () => {
    if (signal.aborted) throw new TradeError('Trade stopped. No further signature will be requested.');
    if (quote.expiresAt <= Date.now() / 1000) throw new TradeError('Quote expired. Request a new one.');
  };
  valid();
  await tradeRequest(session, 'preflight', { ticket: quote.ticket }, signal);
  valid();
  const { address, provider } = await session.getBaseWallet();
  if (address.toLowerCase() !== quote.intent.funder.toLowerCase()) throw new TradeError('This quote belongs to another wallet.');
  if (quote.intent.side === 'buy' && quote.intent.qty !== '5') throw new TradeError('Rehearsal trades are limited to 5 USDC.');
  valid();
  if (quote.approval) {
    progress(`Approve exactly ${quote.intent.qty} ${quote.intent.side === 'sell' ? quote.intent.asset : 'USDC'} in your wallet.`);
    const hash = await provider.request({ method: 'eth_sendTransaction', params: [{ from: address, to: quote.approval.to as Hex, data: quote.approval.data as Hex, value: '0x0', chainId: '0x2105' }] });
    progress('Waiting for the approval to confirm…');
    let confirmed = false;
    for (let attempt = 0; attempt < 45; attempt++) {
      valid();
      const result = await tradeRequest<{ status: string }>(session, 'approval', { ticket: quote.ticket, txHash: hash }, signal);
      if (result.status === 'failed') throw new TradeError('The approval transaction failed. No order was submitted.');
      if (result.status === 'confirmed') { confirmed = true; break; }
      await new Promise<void>(resolve => window.setTimeout(resolve, 2000));
    }
    if (!confirmed) throw new TradeError('Approval is still pending. No order was submitted; check your wallet before continuing.');
  }
  valid();
  progress(`Review and sign your limit ${quote.intent.side} in your wallet.`);
  const signature = await provider.request({ method: 'eth_signTypedData_v4', params: [address, JSON.stringify(quote.typedData)] });
  valid();
  progress('Submitting your signed order once…');
  return tradeRequest(session, 'submit', { ticket: quote.ticket, signature }, signal);
}
