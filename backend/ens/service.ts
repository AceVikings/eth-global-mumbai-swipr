import { traderLabel } from './registrar';
import {createPublicClient,http,encodeFunctionData,decodeFunctionResult,namehash,labelhash,zeroAddress,zeroHash,keccak256,toHex,parseAbi,type Hex,type Address} from 'viem';
import {sepolia} from 'viem/chains';
import {ApiError} from '../auth';
import {ENS,ENS_CHAIN_ID,ENS_KEYS,ensName,dnsName,resolverAbi,universalAbi,profileAbi,registryAbi,subregistryAbi,type EnsStats,type EnsTransaction} from '../contracts/ens';
import type {BotProfile} from '../contracts/bots';
import {buildRecords,compareRecords} from './records';
const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
const fail=(message:string):never=>{throw new ApiError(409,'ens_blocked',message);};
const tx=(to:Address,data:Hex):EnsTransaction=>({to,data,value:'0x0',chainId:ENS_CHAIN_ID});
const checkedName=(v:unknown)=>{try{return ensName(v);}catch{throw new ApiError(400,'invalid_ens_name','Enter a Sepolia .eth name or subname.');}};
export function createEnsService(o:{rpcUrl:string;rootName?:string;profiles:()=>Promise<BotProfile[]>;stats?:(p:BotProfile)=>Promise<EnsStats>;client?:ReturnType<typeof createPublicClient>}){
 const c=o.client??createPublicClient({chain:sepolia,transport:http(o.rpcUrl,{timeout:15000,retryCount:0})});
 const profile=async(id:unknown,wallet?:string)=>{
  const p=(await o.profiles()).find(p=>p.id===id);
  if(!p)throw new ApiError(404,'profile_not_found','Trader profile was not found.');
  if(wallet&&!same(p.owner,wallet))throw new ApiError(403,'not_owner','Only the trader owner can publish ENS records.');
  return p;
 };
 const network=async()=>{if(await c.getChainId()!==ENS_CHAIN_ID)fail('ENS requires Sepolia.');};
 const read=async(name:string,key?:string)=>{
  const fn=key?'text':'addr';
  const data=encodeFunctionData({abi:profileAbi,functionName:fn,args:(key?[namehash(name),key]:[namehash(name)]) as any});
  const [out]=await c.readContract({address:ENS.universal,abi:universalAbi,functionName:'resolve',args:[dnsName(name),data]});
  return decodeFunctionResult({abi:profileAbi,functionName:fn,data:out}) as string;
 };
 const identity=async(name:string,wallet:string)=>{
  await network();
  let holding:Address=ENS.registry,active=true,owner:Address=zeroAddress;
  const head=await c.getBlock();
  const labels=name.split('.').slice(0,-1).reverse();
  for(let i=0;i<labels.length;i++){
   const id=BigInt(labelhash(labels[i]));
   const token=await c.readContract({address:holding,abi:registryAbi,functionName:'getTokenId',args:[id]});
   const [current,status,expiry]=await Promise.all([
    c.readContract({address:holding,abi:registryAbi,functionName:'ownerOf',args:[token]}),
    c.readContract({address:holding,abi:registryAbi,functionName:'getStatus',args:[id]}),
    c.readContract({address:holding,abi:registryAbi,functionName:'getExpiry',args:[id]})]);
   active=active&&Number(status)===2&&expiry>head.timestamp;owner=current;
   if(i<labels.length-1){holding=await c.readContract({address:holding,abi:subregistryAbi,functionName:'getSubregistry',args:[labels[i]]});if(holding===zeroAddress)fail('The ENS parent has no subregistry.');}
  }
  const [resolver]=await c.readContract({address:ENS.universal,abi:universalAbi,functionName:'findResolver',args:[dnsName(name)]});
  if(resolver===zeroAddress)fail('This name has no resolver.');
  const address=await read(name);
  return {owner,resolver,verified:active&&same(owner,wallet)&&same(address,wallet)};
 };
 const expected=async(p:BotProfile)=>{
  let stats:EnsStats|null=null;
  try{stats=o.stats?await o.stats(p):null;}catch{/* Unavailable evidence never becomes zero performance. */}
  return buildRecords(p,stats);
 };
 const prepare=async(name:string,wallet:Address,records:Record<string,string>)=>{
  const found=await identity(name,wallet);if(!found.verified)fail('The active ENS name must be owned by and resolve to this trader wallet.');
  const supported=await c.readContract({address:found.resolver,abi:resolverAbi,functionName:'supportsInterface',args:['0xc7279f88']});
  if(!supported)fail('This name needs an ENSv2 text resolver.');
  const calls=Object.entries(records).map(([key,value])=>encodeFunctionData({abi:resolverAbi,functionName:'setText',args:[dnsName(name),key,value]}));
  const data=encodeFunctionData({abi:resolverAbi,functionName:'multicall',args:[calls]});
  try{await c.call({account:wallet,to:found.resolver,data});}catch{fail('Your wallet does not have permission to update these ENS records.');}
  return tx(found.resolver,data);
 };
 return {
  async snapshot(profileId:unknown){const p=await profile(profileId);return expected(p);},
  async verify(profileId:unknown,input:unknown){
   const p=await profile(profileId),name=checkedName(input??p.ensName??`${traderLabel(p.id)}.${o.rootName||'swipr.eth'}`);const found=await identity(name,p.owner);
   const values=await Promise.all(ENS_KEYS.map(k=>read(name,k)));
   const records=Object.fromEntries(ENS_KEYS.map((k,i)=>[k,values[i]]));
   const timestamp=Date.parse(records['swipr.updatedAt']);
   const fresh=Number.isFinite(timestamp)&&timestamp<=Date.now()+60000&&Date.now()-timestamp<3600000;
   const matches=compareRecords(records,await expected(p),found.verified);
   return {name,chainId:ENS_CHAIN_ID,resolver:found.resolver,owner:found.owner,...matches,statsVerified:matches.statsVerified&&fresh,fresh,records};
  },
  async publish(wallet:Address,input:Record<string,unknown>){
   const p=await profile(input.profileId,wallet),name=checkedName(input.name??p.ensName);
   const records={...await expected(p),'swipr.updatedAt':new Date().toISOString()};
   return {name,records,transaction:await prepare(name,wallet,records)};
  },
  async text(wallet:Address,input:{name:string;key:string;value:string}){
   if(!/^[A-Za-z0-9._:-]{1,64}$/.test(input.key)||input.value.length>8192)fail('Invalid text record.');
   // Stats/profile records are generated by publish(), never caller-supplied claims.
   if(input.key.startsWith('swipr.'))fail('Use the trader publish action for verified Swipr records.');
   return {transaction:await prepare(checkedName(input.name),wallet,{[input.key]:input.value})};
  },
  async receipt(hash:Hex){await network();const r=await c.getTransactionReceipt({hash});return {status:r.status,confirmed:(await c.getBlockNumber({cacheTime:0}))>=r.blockNumber+1n};},
 };
}
export type EnsService=ReturnType<typeof createEnsService>;
