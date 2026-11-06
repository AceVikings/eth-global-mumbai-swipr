import {createApi} from '../api';
import {readConfig} from '../config';
import {expect,it,vi} from 'vitest';
import {encodeFunctionResult} from 'viem';
import {createEnsService} from './service';
import {buildRecords} from './records';
import {ENS,profileAbi} from '../contracts/ens';
const owner=`0x${'12'.repeat(20)}` as const,resolver=`0x${'34'.repeat(20)}` as const;
const p={id:'bot-1',owner,operator:owner,name:'Trader',bio:'Test',style:'Balanced',strategy:'manual',assets:['WETH'],status:'active',createdAt:'2026-11-01T00:00:00Z',updatedAt:'2026-11-01T00:00:00Z'} as any;
function setup({expired=false,denied=false,recordOwner=owner}:{expired?:boolean;denied?:boolean;recordOwner?:string}={}){
 const records={...buildRecords(p,null),'swipr.updatedAt':new Date().toISOString()};
 const client={getChainId:vi.fn(async()=>11155111),getBlock:vi.fn(async()=>({timestamp:1000n})),call:vi.fn(async()=>{if(denied)throw Error('no role');}),getCode:vi.fn(async()=>undefined),readContract:vi.fn(async(a:any)=>{
  if(a.functionName==='getTokenId')return 1n;
  if(a.functionName==='getSubregistry')return ENS.registry;
  if(a.functionName==='ownerOf')return recordOwner;
  if(a.functionName==='getStatus')return 2;
  if(a.functionName==='getExpiry')return expired?900n:2000n;
  if(a.functionName==='findResolver')return [resolver,'0x',0n];
  if(a.functionName==='supportsInterface')return true;
  if(a.functionName==='resolve'){
   // Resolution returns the address for addr(), then text records in requested order.
   const addrSelector='0x3b3b57de';
   if(a.args[1].startsWith(addrSelector))return [encodeFunctionResult({abi:profileAbi,functionName:'addr',result:owner}),resolver];
   const i=client.readContract.mock.calls.filter(([b])=>(b as any).functionName==='resolve'&&!(b as any).args[1].startsWith(addrSelector)).length-1;
   const key=['swipr.profile','swipr.stats','swipr.updatedAt','description'][i%4];
   return [encodeFunctionResult({abi:profileAbi,functionName:'text',result:records[key as keyof typeof records]}),resolver];
  }
  throw Error(`unexpected ${a.functionName}`);
 })};
 return {client,service:createEnsService({rpcUrl:'http://unused',profiles:async()=>[p],client:client as any})};
}
it('verifies live ownership and profile while refusing to imply unavailable stats are verified',async()=>{
 const {service}=setup();expect(await service.verify('bot-1','swiprtrader.eth')).toMatchObject({identityVerified:true,profileMatches:true,statsVerified:false,fresh:true});
});
it('rejects expired names, other profile owners and missing resolver roles before signing',async()=>{
 await expect(setup({expired:true}).service.publish(owner,{profileId:p.id,name:'swiprtrader.eth'})).rejects.toThrow('active ENS name');
 await expect(setup().service.publish(resolver,{profileId:p.id,name:'swiprtrader.eth'})).rejects.toThrow('Only the trader owner');
 await expect(setup({denied:true}).service.publish(owner,{profileId:p.id,name:'swiprtrader.eth'})).rejects.toThrow('permission');
});
it('prepares one zero-value batch against the discovered v2 resolver',async()=>{
 const {service,client}=setup();const r=await service.publish(owner,{profileId:p.id,name:'swiprtrader.eth'});
 expect(r.transaction).toMatchObject({to:resolver,chainId:11155111,value:'0x0'});expect(client.call).toHaveBeenCalledOnce();
 expect(r.transaction.to).not.toBe(ENS.resolverImpl);
});
it('does not allow raw MCP claims to overwrite stats',async()=>{
 await expect(setup().service.text(owner,{name:'swiprtrader.eth',key:'swipr.stats',value:'{"profit":999}'})).rejects.toThrow('publish action');
});

it('exposes actual ENS service through HTTP with authenticated owner-only preparation',async()=>{
 const {service}=setup();const server=createApi({config:readConfig({}),ledger:null,ens:service,authenticate:async()=>({userId:'ens-test',wallets:[owner]})});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const a=server.address() as {port:number};const root=`http://127.0.0.1:${a.port}`;
 try{
  const proof=await fetch(`${root}/api/ens/verify?profileId=bot-1&name=swiprtrader.eth`);
  expect(proof.status).toBe(200);expect(await proof.json()).toMatchObject({identityVerified:true,statsVerified:false});
  const r=await fetch(`${root}/api/ens/publish`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({wallet:owner,profileId:'bot-1',name:'swiprtrader.eth'})});
  expect(r.status).toBe(200);expect(await r.json()).toMatchObject({transaction:{to:resolver,value:'0x0'}});
  expect((await fetch(`${root}/api/ens/publish`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({wallet:resolver,profileId:'bot-1',name:'swiprtrader.eth'})})).status).toBe(403);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

it('checks the parent expiry and versioned token identity for subnames',async()=>{
 const {service,client}=setup({expired:true});
 const proof=await service.verify(p.id,'trader.swipr.eth');
 expect(proof.identityVerified).toBe(false);
 expect(client.readContract.mock.calls.filter(([call])=>(call as any).functionName==='getTokenId')).toHaveLength(2);
 expect(client.readContract.mock.calls.filter(([call])=>(call as any).functionName==='getSubregistry')).toHaveLength(1);
});
