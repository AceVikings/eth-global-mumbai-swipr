import {expect,it,vi} from 'vitest';
import {createHistorySource,createPerformanceSource} from './history-source';
import type {BotProfile} from '../contracts/bots';
import type {SeatDirectory} from '../contracts/seats';
const owner=`0x${'11'.repeat(20)}`,copier=`0x${'22'.repeat(20)}`;
const fills=[{txHash:`0x${'aa'.repeat(32)}`,asset:'WETH',side:'buy',usdcMicros:'5000000',assetUnits:'10',timestamp:1000,blockNumber:1,transactionIndex:0},
 {txHash:`0x${'bb'.repeat(32)}`,asset:'WETH',side:'sell',usdcMicros:'4900000',assetUnits:'10',timestamp:2000,blockNumber:2,transactionIndex:0}];
it('connects profiles and seats to real verified history, reuses reads and keeps honest losses',async()=>{
 const read=vi.fn(async()=>fills),history=createHistorySource({completeHistory:read});
 const source=createPerformanceSource(history,async()=>[{owner,name:'Trader'} as BotProfile],async()=>({passes:[{owner:copier,traderOwner:owner}],availability:[],invitations:[]} as unknown as SeatDirectory));
 const result=await source();expect(result.positions).toHaveLength(2);
 expect(result.positions.map(p=>p.role)).toEqual(['trader','copier']);
 expect(result.positions[0]).toMatchObject({costUsdMicros:'5000000',proceedsUsdMicros:'4900000'});
 await source();expect(read).toHaveBeenCalledTimes(2);
});
it('does not cache a failed history or invent an empty portfolio',async()=>{
 const read=vi.fn().mockRejectedValueOnce(Error('provider down')).mockResolvedValue([]);
 const history=createHistorySource({completeHistory:read});await expect(history(owner)).rejects.toThrow('provider down');
 expect(await history(owner)).toEqual([]);expect(read).toHaveBeenCalledTimes(2);
});
