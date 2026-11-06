import {formatUnits} from 'viem';
import {closedPositions,type VerifiedFill} from '../trading/performance';
import type {BotProfile} from '../contracts/bots';
import type {EnsStats} from '../contracts/ens';
import type {TradingService} from '../trading/service';
import type {createFlashClient} from '../providers/flash';
/** Wallet receipts, not bot attribution or a fabricated closed-position track record. */
export function createEnsStats(flash:Pick<ReturnType<typeof createFlashClient>,'listOrders'>,trades:Pick<TradingService,'status'>){
 const pending=new Map<string,Promise<EnsStats>>();
 const load=async(p:BotProfile):Promise<EnsStats>=>{
  const history=await flash.listOrders(p.owner);
  const fills:NonNullable<EnsStats['fills']>=[],receipts:VerifiedFill[]=[],seen=new Set<string>();
  const orders=history.orders.slice(0,20);
  for(const row of orders){
   const orderId=row.orderId??row.id;
   if(!orderId||row.funderAddress?.toLowerCase()!==p.owner.toLowerCase())throw new Error('Invalid wallet order history.');
  }
  // Bound RPC concurrency and preserve provider order when deduplicating receipts.
  const statuses=[];
  for(let start=0;start<orders.length;start+=4){
   statuses.push(...await Promise.all(orders.slice(start,start+4).map(row=>trades.status(p.owner,(row.orderId??row.id)!))));
  }
  for(let i=0;i<orders.length;i++){
   const orderId=(orders[i].orderId??orders[i].id)!,status=statuses[i];
   if(status.unverifiedFills>0)throw new Error('Some receipts could not be verified.');
   for(const f of status.fills){
    if(seen.has(f.txHash))continue;seen.add(f.txHash);
    receipts.push(f);
    fills.push({orderId,txHash:f.txHash,side:f.side,asset:f.asset,usdcMicros:f.usdcMicros,assetUnits:f.assetUnits});
   }
  }
  const closed=history.hasMore?[]:closedPositions(receipts,p.owner,'trader',p.name);
  const net=closed.reduce((sum,row)=>sum+BigInt(row.proceedsUsdMicros)-BigInt(row.costUsdMicros),0n);
  return {state:'verified',scope:'latest20Orders',attribution:'wallet',wallet:p.owner.toLowerCase(),hasMore:history.hasMore,
   fills:fills.sort((a,b)=>a.txHash.localeCompare(b.txHash)),realizedPnlUsd:closed.length?formatUnits(net,6):null};
 };
 return async(p:BotProfile):Promise<EnsStats>=>{
  const key=p.owner.toLowerCase();
  // Profiles sharing a wallet share the in-flight evidence read, never a stale snapshot.
  let task=pending.get(key);
  if(!task){task=load(p);pending.set(key,task);}
  try{return await task;}finally{if(pending.get(key)===task)pending.delete(key);}
 };
}
