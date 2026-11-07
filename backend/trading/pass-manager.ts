import { encodeFunctionData, erc20Abi, type Address, type Hex } from 'viem';
import { ApiError } from '../auth';
import type { SeatPass } from '../contracts/seats';
import { TOKENS, toUnits, type Asset, type OrderIntent, type FlashQuote } from '../providers/flash';
import { PassBook, portfolio, profitShare, type PassRecord } from './pass-book';
import type { CopyAccounting } from './accounting';
import type { VerifiedFill } from './performance';
const fail = (message: string): never => { throw new ApiError(409,'pass_unavailable',message); };
const terminal = (status: string) => ['FILLED','CANCELLED','TERMINATED','REJECTED','EXPIRED'].includes(status.replace(/^ORDER_STATUS_/,'').toUpperCase());
export const decimalUnits = (n: bigint, decimals: number) => `${n / 10n ** BigInt(decimals)}.${(n % 10n ** BigInt(decimals)).toString().padStart(decimals,'0')}`;
type Status = { status: string; unverifiedFills: number; copyAccountingPending?: boolean; fills: VerifiedFill[] };
type Chain = {
 balance(wallet: string, asset: Asset): Promise<bigint>;
 transfer(hash: string): Promise<{ from: string; to: string; input: string; value: bigint; success: boolean; confirmations: number; timestamp: number }>;
};
export type ExitPlan = { asset: Asset; units: string; reason: string; sharedPrice?: string };
export function traderExitPlans(row: PassRecord, fills: VerifiedFill[]): ExitPlan[] {
 const first = Math.min(...row.fills.filter(f=>f.fill.side==='buy').map(f=>f.at)), inventory = new Map<string,bigint>();
 const p = portfolio(row), seen = new Set<string>();
 for (const f of [...fills].sort((a,b)=>a.blockNumber-b.blockNumber || a.transactionIndex-b.transactionIndex)) {
  if (seen.has(f.txHash)) continue; seen.add(f.txHash);
  const before = inventory.get(f.asset) ?? 0n, units = BigInt(f.assetUnits);
  inventory.set(f.asset, f.side==='buy' ? before+units : before>units ? before-units : 0n);
  if (f.side!=='sell' || f.timestamp<first || before===0n || (f.asset!=='WETH' && f.asset!=='cbBTC')) continue;
  const reason = `trader-${f.txHash.slice(2)}`, prior = row.exits.filter(x=>x.reason===reason && x.asset===f.asset);
  const owned = p.positions.get(f.asset)?.units ?? 0n;
  const desired = prior.length ? BigInt(prior[0].units) - row.fills.filter(x=>prior.some(e=>e.orderId===x.orderId)).reduce((n,x)=>n+BigInt(x.fill.units),0n) : owned*(units<before?units:before)/before;
  if (desired<=0n) continue;
  const priceMicros = BigInt(f.usdcMicros) * 10n ** BigInt(TOKENS[f.asset].decimals) / units;
  return [{asset:f.asset as Asset,units:(desired<owned?desired:owned).toString(),reason,sharedPrice:decimalUnits(priceMicros,6)}].filter(x=>BigInt(x.units)>0n);
 }
 return [];
}
export function createPassManager(o: { book: PassBook; accounting: CopyAccounting; seat(wallet: string, id: string): Promise<SeatPass>;
 status(wallet: string,id: string): Promise<Status>; history(wallet: string): Promise<VerifiedFill[]>; quote(intent: OrderIntent): Promise<FlashQuote>; chain: Chain }) {
 const sync = async (wallet: string, seatId: string) => {
  const seat = await o.seat(wallet,seatId), entries = (await o.accounting.entries()).filter(e=>e.seatId===seatId);
  let pending = false;
  for (const entry of entries) {
   if (!entry.orderId) { pending=true; continue; }
   const s = await o.status(wallet,entry.orderId);
   if (s.unverifiedFills || s.copyAccountingPending) fail('Waiting for verified entry receipts.');
   pending ||= !terminal(s.status);
  }
  let row = await o.book.state(seatId);
  for (const exit of row.exits.filter(e=>!e.terminal)) {
   if (!exit.orderId) { pending=true; continue; }
   const s = await o.status(wallet,exit.orderId);
   if (s.unverifiedFills || s.copyAccountingPending) fail('Waiting for verified exit receipts.');
   pending ||= !terminal(s.status);
  }
  row = await o.book.state(seatId);
  return { seat, row, pending };
 };
 const snapshot = async (wallet: string, seatId: string, end = false) => {
  let { seat, row, pending } = await sync(wallet,seatId);
  const p = portfolio(row), positions = []; let pnl = p.realized;
  for (const [asset, position] of p.positions) {
   if (!position.units) continue;
   const balance = await o.chain.balance(wallet,asset);
   // Transfers and unrelated sells must never produce invented pass profits.
   if (balance<position.units) fail('Wallet inventory changed outside this pass. Reconcile its transfers before settlement.');
   const quote = await o.quote({side:'sell',asset,qty:decimalUnits(position.units,TOKENS[asset].decimals),funder:wallet,orderType:'market',maxSlippage:'0.01',maxPriceImpact:'0.01',integratorFeeBps:'10'});
   const output = (quote.raw as {to?:{amount?:unknown}}).to?.amount;
   if (typeof output!=='string') fail('A live exit valuation is unavailable.');
   const value = toUnits(output as string,6); pnl += value-position.cost;
   positions.push({asset,units:position.units.toString(),cost:position.cost.toString(),value:value.toString(),stop:seat.terms.safetyNetBps>0 && value*10000n<=position.cost*BigInt(10000-seat.terms.safetyNetBps)});
  }
  await o.book.mark(seatId,pnl,BigInt(seat.terms.breakupUsd)*1000000n,end || Date.now()>=seat.expiresAt);
  row = await o.book.state(seatId);
  const plans: ExitPlan[] = row.ended || row.paused && seat.terms.liquidateOnBreakup
   ? positions.map(p=>({asset:p.asset,units:p.units,reason:'cashout'}))
   : positions.filter(p=>p.stop).map(p=>({asset:p.asset,units:p.units,reason:'stop'}));
  if (!plans.length && positions.length) plans.push(...traderExitPlans(row,await o.history(seat.traderOwner)));
  return { seat, pending, paused:row.paused,ended:row.ended,highWater:row.highWater.toString(),pnl:pnl.toString(),realized:p.realized.toString(),positions,plans,
   exits:row.exits,settlement:row.settlement??null,fee:positions.length || pending ? null : profitShare(p.realized).toString() };
 };
 return {
  snapshot,
  async exit(wallet: string,seatId: string,asset: Asset,reason: string) {
   const s = await snapshot(wallet,seatId,reason==='cashout');
   const plan = s.plans.find(p=>p.asset===asset&&p.reason===reason);
   if (!plan || s.pending) return fail('Wait for outstanding orders, then choose an available exit.');
   return {profileId:s.seat.traderId,seatId,asset,qty:decimalUnits(BigInt(plan.units),TOKENS[asset].decimals),side:'sell',exitReason:reason,
    ...(plan.sharedPrice?{sharedPrice:plan.sharedPrice}:{market:true})};
  },
  async prepareSettlement(wallet: string,seatId: string) {
   const s = await snapshot(wallet,seatId,true);
   if (s.positions.length || s.pending || s.settlement) return fail('Close all pass positions and wait for orders before settling.');
   const amount = BigInt(s.fee!);
   return {seatId,amount:amount.toString(),trader:s.seat.traderOwner,chainId:8453,to:TOKENS.USDC.address,
    data:encodeFunctionData({abi:erc20Abi,functionName:'transfer',args:[s.seat.traderOwner as Address,amount]}),value:'0x0'};
  },
  async settle(wallet: string,seatId: string,hash: unknown) {
   const prepared = await this.prepareSettlement(wallet,seatId),amount = BigInt(prepared.amount),row=await o.book.state(seatId);
   if (amount>0n) {
    if (typeof hash!=='string'||!/^0x[0-9a-f]{64}$/i.test(hash)) return fail('Provide your confirmed USDC settlement transaction.');
    const tx = await o.chain.transfer(hash!);
    if (!tx.success||tx.confirmations<2||tx.from.toLowerCase()!==wallet||tx.to.toLowerCase()!==TOKENS.USDC.address.toLowerCase()||tx.input.toLowerCase()!==prepared.data.toLowerCase()||tx.value!==0n||tx.timestamp<(row.endedAt??Infinity)) return fail('Settlement receipt does not match this pass.');
   } else if (hash) return fail('No payment is due for this pass.');
   await o.book.settle(seatId,amount,amount>0n?String(hash).toLowerCase():null);
   return {seatId,amount:amount.toString(),txHash:amount>0n?hash:null,settled:true};
  },
 };
}
