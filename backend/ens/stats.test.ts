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
