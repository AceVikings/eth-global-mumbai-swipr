import {expect,it,vi} from 'vitest';
import {createEnsStats} from './stats';
const owner=`0x${'12'.repeat(20)}`,p={owner} as any;
const fill={txHash:`0x${'ab'.repeat(32)}`,side:'buy',asset:'WETH',usdcMicros:'5000000',assetUnits:'2225136924453823'};
it('includes only verified receipts once and never treats an open buy as realized profit',async()=>{
 const stats=createEnsStats({listOrders:async()=>({orders:[{orderId:'a',funderAddress:owner},{orderId:'b',funderAddress:owner}],hasMore:true})},
 {status:vi.fn(async()=>({status:'filled',orderId:'a',fills:[fill],unverifiedFills:0}))} as any);
 expect(await stats(p)).toMatchObject({state:'verified',attribution:'wallet',hasMore:true,fills:[{...fill,orderId:'a'}],realizedPnlUsd:null});
});
it('rejects incomplete evidence instead of reporting verified empty history',async()=>{
 const flash={listOrders:async()=>({orders:[{orderId:'a',funderAddress:owner}],hasMore:false})};
 await expect(createEnsStats(flash,{status:async()=>({fills:[],unverifiedFills:1})} as any)(p)).rejects.toThrow('could not be verified');
 await expect(createEnsStats({listOrders:async()=>({orders:[{orderId:'a',funderAddress:'another-wallet'}],hasMore:false})},{} as any)(p)).rejects.toThrow('Invalid wallet');
});

it('publishes FIFO realized cash flow only when the available wallet history is complete',async()=>{
 const buy={...fill,blockNumber:1,transactionIndex:0,timestamp:1800000000000};
 const sell={...buy,txHash:`0x${'cd'.repeat(32)}`,side:'sell',usdcMicros:'4900000',blockNumber:2,timestamp:1800000002000};
 const flash={listOrders:async()=>({orders:[{orderId:'buy',funderAddress:owner},{orderId:'sell',funderAddress:owner}],hasMore:false})};
 const trades={status:async(_:string,id:string)=>({fills:[id==='buy'?buy:sell],unverifiedFills:0})} as any;
 expect(await createEnsStats(flash,trades)(p)).toMatchObject({realizedPnlUsd:'-0.1'});
 expect(await createEnsStats({listOrders:async()=>({...await flash.listOrders(),hasMore:true})},trades)(p)).toMatchObject({realizedPnlUsd:null});
});

it('coalesces simultaneous wallet reads and bounds receipt concurrency without caching failures',async()=>{
 let inFlight=0,maximum=0;
 const listOrders=vi.fn(async()=>({orders:Array.from({length:9},(_,i)=>({orderId:String(i),funderAddress:owner})),hasMore:false}));
 let reject=true;
 const status=vi.fn(async()=>{inFlight++;maximum=Math.max(maximum,inFlight);await new Promise(r=>setTimeout(r,1));inFlight--;return {fills:[],unverifiedFills:reject?1:0};});
 const stats=createEnsStats({listOrders},{status} as any);
 const failed=await Promise.allSettled([stats(p),stats({...p,id:'another-profile'})]);
 expect(failed.every(r=>r.status==='rejected')).toBe(true);
 expect(listOrders).toHaveBeenCalledTimes(1);expect(maximum).toBe(4);
 reject=false;
 expect(await stats(p)).toMatchObject({state:'verified',fills:[]});
 expect(listOrders).toHaveBeenCalledTimes(2);
});
