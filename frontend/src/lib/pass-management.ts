import { ExpirationTime } from '@arkiv-network/sdk';
import { and, eq } from '@arkiv-network/sdk/query';
import { str, addr } from '@arkiv-network/sdk/schema';
import { decodeFunctionData, erc20Abi, type Hex } from 'viem';
import type { Session } from '../auth/Session';
import { WalletSettlementSchema, WALLET_PROFILE_PROJECT, walletJson } from '../contracts/wallet-profile';
import { arkivConnection, fundArkivWrite } from './arkiv';
import { tradeRequest } from './trading';
export type PassState = {
 pending: boolean; paused: boolean; ended: boolean; pnl: string; realized: string; highWater: string; fee: string | null;
 positions: {asset:'WETH'|'cbBTC';units:string;cost:string;value:string;stop:boolean}[];
 plans: {asset:'WETH'|'cbBTC';units:string;reason:string;sharedPrice?:string}[];
 settlement: null | {amount:string;txHash:string|null};
};
export type SettlementQuote = {seatId:string;amount:string;trader:string;chainId:number;to:string;data:Hex;value:string};
const usdc='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export async function settlePass(session:Session,quote:SettlementQuote,progress:(text:string)=>void) {
 const owner=session.address?.toLowerCase();if(!owner)throw Error('Sign in to settle.');
 if(quote.chainId!==8453||quote.to.toLowerCase()!==usdc.toLowerCase()||quote.value!=='0x0'||!/^\d+$/.test(quote.amount))throw Error('Invalid settlement.');
 const decoded=decodeFunctionData({abi:erc20Abi,data:quote.data});
 if(decoded.functionName!=='transfer'||decoded.args[0].toLowerCase()!==quote.trader.toLowerCase()||decoded.args[1]!==BigInt(quote.amount))throw Error('Settlement does not match the reviewed amount.');
 const storageKey=`swipr.settlement.${owner}.${quote.seatId}`;
 let hash=localStorage.getItem(storageKey);
 if(BigInt(quote.amount)>0n&&!hash){
  const {address,provider}=await session.getBaseWallet();if(address.toLowerCase()!==owner)throw Error('Your account changed.');
  progress('Review the trader payment in your wallet.');
  hash=await provider.request({method:'eth_sendTransaction',params:[{from:address,to:usdc,data:quote.data,value:'0x0',chainId:'0x2105'}]}) as string;
  if(!/^0x[0-9a-f]{64}$/i.test(hash))throw Error('Check your wallet for the settlement transaction.');
  localStorage.setItem(storageKey,hash);
 }
 progress('Verifying settlement…');
 for(let i=0;i<45;i++){
  if(session.address?.toLowerCase()!==owner)throw Error('Your account changed.');
  try {
   const result=await tradeRequest<{settled:boolean;amount:string;txHash:string|null}>(session,'pass-settlement',{seatId:quote.seatId,txHash:hash});
   if(!result.settled)throw Error('Settlement is pending.');
   await saveSettlementReceipt(session,quote.seatId,{...result,trader:quote.trader});
   localStorage.removeItem(storageKey);return result;
  }catch(error){if(!hash||i===44)throw error;}
  await new Promise(r=>setTimeout(r,2000));
 }
 throw Error('Settlement is pending. Use its receipt to reconcile; do not pay again.');
}
export async function saveSettlementReceipt(session:Session,seatId:string,receipt:unknown){
 const {client,reader,address}=await arkivConnection(session);
 if(address.toLowerCase()!==session.address?.toLowerCase())throw Error('Your account changed.');
 const prior=await reader.query(and(eq('arkiv.schema',str('swipr.wallet-settlement.v1')),eq('project',str(WALLET_PROFILE_PROJECT)),eq('seatId',str(seatId)),eq('$owner',addr(address))),{limit:1});
 if(prior.entities.length)return;
 await fundArkivWrite(session,address);
 const saved=await client.createEntity(WalletSettlementSchema,{project:WALLET_PROFILE_PROJECT,seatId,receipt:walletJson(receipt)},{expiration:ExpirationTime.fromDays(180),flags:{readonly:true}});
 await client.waitForTransactionReceipt({hash:saved.txHash,confirmations:2});
 return saved;
}
