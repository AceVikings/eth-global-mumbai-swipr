import { expect, it, vi } from 'vitest';
import { encodeFunctionData, erc20Abi } from 'viem';
import type { Journal, JournalEvent } from '../arkiv-journal';
import { CopyAccounting } from './accounting';
import { PassBook } from './pass-book';
import { createPassManager, traderExitPlans } from './pass-manager';
import { TOKENS } from '../providers/flash';
const id=`0x${'11'.repeat(32)}`,owner=`0x${'22'.repeat(20)}`,trader=`0x${'33'.repeat(20)}`;
const tx=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`;
class Memory implements Journal {
 canWrite=true;events:JournalEvent[]=[];
 async read(){return {events:structuredClone(this.events),nonce:this.events.length,timestampMs:Date.now(),blockNumber:1n};}
 async append(e:JournalEvent,n:number){if(n!==this.events.length)throw Error('conflict');this.events.push(e);}
 async close(){}
}
async function setup() {
 const journal=new Memory(),book=new PassBook(journal),accounting=new CopyAccounting(journal);
 const seat={id,owner,traderOwner:trader,traderId:tx(99),budgetVersion:1,expiresAt:Date.now()+600000,terms:{perTradeUsd:5,tradeCount:2,breakupUsd:1,safetyNetBps:500,liquidateOnBreakup:false}} as any;
 await book.fill(id,'buy',{txHash:tx(1),asset:'WETH',side:'buy',units:'1000000000000000',cash:'5000000'});
 const quote=vi.fn(async()=>({raw:{to:{amount:'5.2'}}}) as any),balance=vi.fn(async()=>1000000000000000n);
 const transfer=vi.fn(async()=>({from:owner,to:TOKENS.USDC.address,input:'0x',value:0n,success:true,confirmations:2,timestamp:Date.now()+10000}));
 const manager=createPassManager({book,accounting,seat:async()=>seat,status:async()=>({status:'FILLED',unverifiedFills:0,fills:[]}),history:async()=>[],quote,chain:{balance,transfer}});
 return {manager,book,seat,quote,balance,transfer};
}
it('uses net executable proceeds for unrealized PnL and pauses on a real high-water drawdown',async()=>{
 const {manager,quote}=await setup();
 expect(await manager.snapshot(owner,id)).toMatchObject({pnl:'200000',highWater:'200000',paused:false});
 quote.mockResolvedValue({raw:{to:{amount:'4.2'}}});
 expect(await manager.snapshot(owner,id)).toMatchObject({pnl:'-800000',paused:true,plans:[{asset:'WETH',reason:'stop'}]});
});
it('fails closed on missing prices or externally reduced inventory',async()=>{
 const {manager,quote,balance}=await setup();quote.mockResolvedValue({raw:{}});
 await expect(manager.snapshot(owner,id)).rejects.toThrow('valuation');
 balance.mockResolvedValue(1n);await expect(manager.snapshot(owner,id)).rejects.toThrow('outside');
});
it('ends entries before cashout but does not settle an open position',async()=>{
 const {manager,book}=await setup();
 expect(await manager.exit(owner,id,'WETH','cashout')).toMatchObject({qty:'0.001000000000000000',market:true});
 expect(await book.state(id)).toMatchObject({paused:true,ended:true});
 await expect(manager.prepareSettlement(owner,id)).rejects.toThrow('Close');
});
it('checks the exact fee transfer and rejects a reused receipt',async()=>{
 const {manager,book,transfer}=await setup();
 await book.reserve(id,'q','WETH',1000000000000000n,'cashout');await book.submitted('q','sell');
 await book.fill(id,'sell',{txHash:tx(2),asset:'WETH',side:'sell',units:'1000000000000000',cash:'7000000'});await book.terminal('sell');
 const p=await manager.prepareSettlement(owner,id);expect(p.amount).toBe('100000');
 await expect(manager.settle(owner,id,tx(3))).rejects.toThrow('receipt');
 transfer.mockResolvedValue({from:owner,to:TOKENS.USDC.address,input:encodeFunctionData({abi:erc20Abi,functionName:'transfer',args:[trader as `0x${string}`,100000n]}),value:0n,success:true,confirmations:2,timestamp:Date.now()+10000});
 expect(await manager.settle(owner,id,tx(3))).toMatchObject({settled:true,amount:'100000'});
});
it('fans out the same trader exit fraction and price, suppressing already filled exits',async()=>{
 const {book}=await setup(),row=await book.state(id),at=Date.now()+1000;
 const fills=[{txHash:tx(10),asset:'WETH',side:'buy',assetUnits:'200',usdcMicros:'10000000',blockNumber:1,transactionIndex:0,timestamp:at},
 {txHash:tx(11),asset:'WETH',side:'sell',assetUnits:'100',usdcMicros:'6000000',blockNumber:2,transactionIndex:0,timestamp:at+1000}];
 expect(traderExitPlans(row,fills)).toEqual([{asset:'WETH',units:'500000000000000',reason:`trader-${tx(11).slice(2)}`,sharedPrice:'60000000000000000.000000'}]);
});
