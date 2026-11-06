import {expect,it} from 'vitest';
import {createApi} from '../api';
import {readConfig} from '../config';
import type {TradingService} from '../trading/service';
import type {BotProfile} from '../contracts/bots';
const wallet=`0x${'11'.repeat(20)}`,owner=`0x${'22'.repeat(20)}`,traderId=`0x${'33'.repeat(32)}`;
it('derives authenticated wallet ghosts through the actual HTTP API and does not invent missing history',async()=>{
 const ghost={traderId,startedAt:1000,expiresAt:10000,perTradeUsd:5,includedSignalId:null};
 const server=createApi({config:readConfig({}),ledger:null,authenticate:async()=>({userId:'test',wallets:[wallet]}),
  walletProfiles:async()=>[{id:traderId,owner}] as BotProfile[],
  walletGhosts:async()=>[{entityKey:traderId as `0x${string}`,ghost,status:'active'}],
  trading:{completeHistory:async()=>[]} as unknown as TradingService});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try{
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const response=await fetch(`${base}/api/ghosts/results?wallet=${wallet}`);
  expect(response.status).toBe(200);expect(await response.json()).toMatchObject({results:[{state:'ready',buys:0,closedTrades:0,realizedPnlUsd:'0.000000'}]});
  expect((await fetch(`${base}/api/ghosts/results?wallet=${owner}`)).status).toBe(403);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
