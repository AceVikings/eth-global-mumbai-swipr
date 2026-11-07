import {passRecords} from './pass-book';
import {randomUUID} from 'node:crypto';
import {withJournalWrite,type Journal,type JournalEvent} from '../arkiv-journal';
import type {SeatPass} from '../contracts/seats';
import {ApiError} from '../auth';
type Reserve = {type:'project.copy.reserve';quoteId:string;sourceOrderId:string;seatId:string;wallet:string;amount:string;cap:string;count:number;expiresAt:number};
type Submit = {type:'project.copy.submit';quoteId:string;orderId:string};
type Reconcile = {type:'project.copy.reconcile';orderId:string;filled:string};
type Command = Reserve|Submit|Reconcile;
type Row=Reserve & {orderId?:string;settled?:string};
const fail=(text:string):never=>{throw new ApiError(409,'copy_budget',text);};
const key=(s:unknown)=>typeof s==='string'&&/^[a-z0-9_-]{1,128}$/i.test(s);
const amount=(s:unknown)=>typeof s==='string'&&/^[1-9]\d{0,24}$/.test(s);
export const isCopyCommand=(raw:unknown)=>!!raw&&typeof raw==='object'&&String((raw as {type?:unknown}).type).startsWith('project.copy.');
export function validateCopyCommand(raw:unknown):Command {
 const c=raw as Command;
 if(!c||!isCopyCommand(c))return fail('Invalid copy history.');
 if(c.type==='project.copy.reserve') {
  if(!key(c.quoteId)||!key(c.sourceOrderId)||!/^0x[0-9a-f]{64}$/i.test(c.seatId)||!/^0x[0-9a-f]{40}$/.test(c.wallet)
   ||!amount(c.amount)||!amount(c.cap)||BigInt(c.amount)>BigInt(c.cap)||!Number.isInteger(c.count)||c.count<1||c.count>20||!Number.isSafeInteger(c.expiresAt))return fail('Invalid copy reservation.');
 }else if(c.type==='project.copy.submit') {if(!key(c.quoteId)||!key(c.orderId))return fail('Invalid copy order.');}
 else if(c.type==='project.copy.reconcile'){if(!key(c.orderId)||!(c.filled==='0'||amount(c.filled)))return fail('Invalid copy settlement.');}
 else return fail('Unknown copy history.');
 return c;
}
function replay(events:JournalEvent[]) {
 const rows=new Map<string,Row>();
 for(const e of events){
  if(!isCopyCommand(e.command))continue;
  const c=validateCopyCommand(e.command);
  if(c.type==='project.copy.reserve'){
   if(rows.has(c.quoteId)||[...rows.values()].some(r=>r.seatId===c.seatId&&r.sourceOrderId===c.sourceOrderId))fail('Duplicate copy reservation.');
   rows.set(c.quoteId,{...c});
  }else if(c.type==='project.copy.submit'){
   const row=rows.get(c.quoteId);if(!row||row.orderId)fail('Invalid copy order sequence.');row!.orderId=c.orderId;
  }else{
   const row=[...rows.values()].find(r=>r.orderId===c.orderId);if(!row||row.settled!==undefined||BigInt(c.filled)>BigInt(row.amount))fail('Invalid copy settlement sequence.');row!.settled=c.filled;
  }
 }
 return rows;
}
/** Holds are stored before Flash submission. A lost acknowledgement consumes capacity until reconciled. */
export class CopyAccounting {
 constructor(private journal:Journal){}
 private cache:{until:number;value:Promise<Map<string,Row>>}|null=null;
 private read(){if(this.cache&&this.cache.until>Date.now())return this.cache.value;const value=this.journal.read().then(s=>replay(s.events)).catch(e=>{this.cache=null;throw e;});this.cache={until:Date.now()+5000,value};return value;}
 private async write<T>(plan:(rows:Map<string,Row>,at:number)=>{command?:Command;result:T}):Promise<T>{
  return withJournalWrite(this.journal,async()=>{
   if(!this.journal.canWrite)fail('Copy accounting is unavailable.');
   this.cache=null;
   const snapshot=await this.journal.read(),rows=replay(snapshot.events),step=plan(rows,snapshot.timestampMs);
   if(step.command?.type==='project.copy.reserve'&&passRecords(snapshot.events).get(step.command.seatId)?.paused)fail('This pass has paused new entries.');
   if(step.command)await this.journal.append({revision:snapshot.nonce+1,id:randomUUID(),at:snapshot.timestampMs,command:validateCopyCommand(step.command)},snapshot.nonce);
   this.cache=null;
   return step.result;
  });
 }
 async entries(){return [...(await this.read()).values()];}
 async hasSource(seatId:string,sourceOrderId:string){return [...replay((await this.journal.read()).events).values()].some(r=>r.seatId===seatId&&r.sourceOrderId===sourceOrderId);}
 async pendingOrders(){
  return [...replay((await this.journal.read()).events).values()]
   .filter((r):r is Row&{orderId:string}=>!!r.orderId&&r.settled===undefined)
   .map(r=>({wallet:r.wallet,orderId:r.orderId}));
 }
 async available(seat:SeatPass){
  const snapshot=await this.journal.read();if(passRecords(snapshot.events).get(seat.id)?.paused)return false;const rows=[...replay(snapshot.events).values()].filter(r=>r.seatId===seat.id&&r.settled!=='0');
  return seat.budgetVersion===1&&snapshot.timestampMs<seat.expiresAt&&rows.length<seat.terms.tradeCount&&rows.reduce((n,r)=>n+BigInt(r.settled??r.amount),0n)+5000000n<=BigInt(seat.terms.perTradeUsd*seat.terms.tradeCount)*1000000n;
 }
 reserve(seat:SeatPass,sourceOrderId:string,quoteId:string,value:bigint){
  return this.write<{created:boolean;orderId?:string}>((rows,at)=>{
   const existing=[...rows.values()].find(r=>r.quoteId===quoteId||r.seatId===seat.id&&r.sourceOrderId===sourceOrderId);
   if(existing){if(existing.wallet!==seat.owner||existing.amount!==value.toString()||existing.seatId!==seat.id||existing.sourceOrderId!==sourceOrderId)fail('Copy reservation conflict.');return {result:{created:false,orderId:existing.orderId}};}
   if(seat.budgetVersion!==1)fail('Rejoin this older pass before trading so earlier untracked fills cannot reset its budget.');
   if(at>=seat.expiresAt)fail('This Copy Pass expired.');
   const perTrade=BigInt(seat.terms.perTradeUsd)*1000000n,cap=perTrade*BigInt(seat.terms.tradeCount);
   if(value<=0n||value>perTrade)fail('Copy size exceeds the frozen pass size.');
   const prior=[...rows.values()].filter(r=>r.seatId===seat.id&&r.settled!=='0');
   const used=prior.reduce((n,r)=>n+BigInt(r.settled??r.amount),0n);
   if(prior.length>=seat.terms.tradeCount||used+value>cap)fail('This pass has used its trade count or budget.');
   return {command:{type:'project.copy.reserve',quoteId,sourceOrderId,seatId:seat.id,wallet:seat.owner,amount:value.toString(),cap:cap.toString(),count:seat.terms.tradeCount,expiresAt:seat.expiresAt},result:{created:true}};
  });
 }
 submitted(quoteId:string,orderId:string){return this.write<void>(rows=>{
  const row=rows.get(quoteId);if(!row)fail('Missing copy reservation.');
  if(row!.orderId){if(row!.orderId!==orderId)fail('Copy order conflict.');return {result:undefined};}
  return {command:{type:'project.copy.submit',quoteId,orderId},result:undefined};
 });}
 async reconcile(orderId:string,terminal:boolean,filled:bigint){const prior=(await this.entries()).find(r=>r.orderId===orderId);if(!prior||!terminal||prior.settled!==undefined)return;return this.write<void>(rows=>{
  const row=[...rows.values()].find(r=>r.orderId===orderId);
  if(!row||!terminal||row.settled!==undefined)return {result:undefined};
  if(filled<0n||filled>BigInt(row.amount))fail('Copy settlement exceeds its reservation.');
  return {command:{type:'project.copy.reconcile',orderId,filled:filled.toString()},result:undefined};
 });}
}
