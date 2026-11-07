import type {ExitLimits} from './policy';
import {createPublicClient}from'@arkiv-network/sdk';
import {rabdi}from'@arkiv-network/sdk/chains';
import {and,eq,asc}from'@arkiv-network/sdk/query';
import {str}from'@arkiv-network/sdk/schema';
import{http,hexToString,type Hex}from'viem';
import{WALLET_PROFILE_PROJECT,WALLET_AUTOMATION_SCHEMA}from'../contracts/wallet-profile';
export type Grant={entityKey?:string;wallet:string;walletId:string;seatId:string;policyId:string;signerId:string;vault:string;expiresAt:number;exitLimits?:ExitLimits;entries?:boolean};
export function parseGrant(raw:unknown):Grant{
 const g=raw as Grant;
 if(!g||!/^0x[0-9a-f]{40}$/i.test(g.wallet)||!/^0x[0-9a-f]{64}$/i.test(g.seatId)||!/^0x[0-9a-f]{40}$/i.test(g.vault)
 ||![g.walletId,g.policyId,g.signerId].every(s=>typeof s==='string'&&/^[a-z0-9]{10,64}$/.test(s))||!Number.isSafeInteger(g.expiresAt))throw Error('Invalid automation permission.');
 if(g.entries!==undefined&&typeof g.entries!=='boolean')throw Error('Invalid entry scope.');
 if(g.exitLimits&&(!Object.keys(g.exitLimits).length||Object.entries(g.exitLimits).some(([a,v])=>!['WETH','cbBTC'].includes(a)||typeof v!=='string'||!/^[1-9]\d{0,29}$/.test(v))))throw Error('Invalid exit limits.');
 return {wallet:g.wallet.toLowerCase(),walletId:g.walletId,seatId:g.seatId.toLowerCase(),policyId:g.policyId,signerId:g.signerId,vault:g.vault,expiresAt:g.expiresAt,...(g.exitLimits?{exitLimits:g.exitLimits,entries:g.entries===true}:{})};
}
export function createGrants(options:{accessKey?:string;rpcUrl?:string}){
 const client=createPublicClient({chain:rabdi({accessKey:options.accessKey||''}),transport:http(options.rpcUrl,{retryCount:0,timeout:10000})});
 return async()=>{
  if(await client.getChainId()!==7794095)throw Error('Wrong permission storage chain.');
  const head=await client.getBlockNumber({cacheTime:0}),grants:Grant[]=[];
  for(let offset=0;offset<500;offset+=100){
   const page=await client.query(and(eq('project',str(WALLET_PROFILE_PROJECT)),eq('arkiv.schema',str(WALLET_AUTOMATION_SCHEMA))),{offset,limit:100,orderBy:asc('$key')});
   for(const e of page.entities){
    if(e.$expiresAt<=head||e.$updatedAt>head-1n||e.$attributes.grant?.type!=='bytes'||!e.$creationFlags.readonly||e.$owner.toLowerCase()!==e.$creator.toLowerCase())continue;
    try{const grant=parseGrant(JSON.parse(hexToString(e.$attributes.grant.value as Hex)));if(grant.wallet===e.$owner.toLowerCase())grants.push({...grant,entityKey:e.$key});}catch{/* A public schema is not a signing permission. */}
   }
   if(page.entities.length<100)return grants;
  }
  throw Error('Permission directory exceeds its supported limit.');
 };
}
