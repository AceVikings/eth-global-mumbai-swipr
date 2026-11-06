import {formatUnits} from 'viem';
import {closedPositions,type VerifiedFill} from '../trading/performance';
import type {BotProfile} from '../contracts/bots';
import type {EnsStats} from '../contracts/ens';
import type {TradingService} from '../trading/service';
import type {createFlashClient} from '../providers/flash';
/** Wallet receipts, not bot attribution or a fabricated closed-position track record. */
export function createEnsStats(flash:Pick<ReturnType<typeof createFlashClient>,'listOrders'>,trades:Pick<TradingService,'status'>){
 return async(p:BotProfile):Promise<EnsStats>=>{
  const history=await flash.listOrders(p.owner);
  const fills:NonNullable<EnsStats['fills']>=[],receipts:VerifiedFill[]=[],seen=new Set<string>();
  for(const row of history.orders.slice(0,20)){
   const orderId=row.orderId??row.id;
   if(!orderId||row.funderAddress?.toLowerCase()!==p.owner.toLowerCase())throw new Error('Invalid wallet order history.');
   const status=await trades.status(p.owner,orderId);
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
}
