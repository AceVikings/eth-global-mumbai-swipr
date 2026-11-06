import {createPublicClient,createWalletClient,http,encodeFunctionData,decodeFunctionResult,namehash,labelhash,keccak256,toHex,zeroAddress,zeroHash,parseAbi,parseEther,type Address,type Hex} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {sepolia} from 'viem/chains';
import {ApiError} from '../auth';
import {ENS,ensName,dnsName,resolverAbi,registryAbi,subregistryAbi,factoryAbi,profileAbi,universalAbi,registrarAbi} from '../contracts/ens';
import type {BotProfile} from '../contracts/bots';
const ALL=BigInt('0x'+'1'.repeat(64)),YEAR=31536000n;
const OWNER_ROLES=(1n<<20n)|(1n<<24n)|((1n<<20n|1n<<24n|1n<<28n)<<128n);
const KEYS=['swipr.profile','swipr.stats','swipr.updatedAt'];
const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
export const traderLabel=(id:string)=>`trader-${keccak256(toHex(id)).slice(2,18)}`;
const blocked=(message:string):never=>{throw new ApiError(409,'ens_blocked',message);};
export function createEnsRegistrar(o:{key:Hex;rootName:string;rpcUrl:string;profiles:()=>Promise<BotProfile[]>;snapshot:(id:string)=>Promise<Record<string,string>>}){
 const rootName=ensName(o.rootName);if(rootName.split('.').length!==2)throw Error('ENS root must be a second-level .eth name.');
 const rootLabel=rootName.split('.')[0],account=privateKeyToAccount(o.key),transport=http(o.rpcUrl,{timeout:10000,retryCount:0});
 const c=createPublicClient({chain:sepolia,transport}),w=createWalletClient({account,chain:sepolia,transport});
 let queue=Promise.resolve();
 const hasCode=async(address:Address)=>{const code=await c.getCode({address});return !!code&&code!=='0x';};
 const send=async(to:Address,data:Hex)=>{
  if(await c.getChainId()!==11155111)blocked('Wrong ENS network.');
  const nonce=await c.getTransactionCount({address:account.address,blockTag:'latest'});
  if(await c.getTransactionCount({address:account.address,blockTag:'pending'})!==nonce)blocked('An ENS transaction is pending. Reconcile it before continuing.');
  await c.call({account:account.address,to,data});
  const gas=await c.estimateGas({account:account.address,to,data}),gasPrice=await c.getGasPrice();
  if(gas>2000000n||gas*gasPrice>parseEther('0.002'))blocked('ENS sponsorship is paused while gas is high.');
  const hash=await w.sendTransaction({to,data,nonce,gas:gas*12n/10n,gasPrice,type:'legacy',value:0n});
  // Chain state is the idempotency key for every setup stage; unknown sends are never retried here.
  const receipt=await c.waitForTransactionReceipt({hash,confirmations:2,timeout:18000}).catch(()=>null);
  if(receipt?.status==='reverted')blocked('The ENS transaction reverted. No setup change was applied.');
  return hash;
 };
 const predicted=(salt:bigint)=>c.readContract({address:ENS.factory,abi:factoryAbi,functionName:'predictProxyAddress',args:[account.address,salt]});
 const deploy=async(impl:Address,salt:bigint,init:Hex)=>{
  const address=await predicted(salt);
  if(await hasCode(address))return {address};
  return {address,txHash:await send(ENS.factory,encodeFunctionData({abi:factoryAbi,functionName:'deployProxy',args:[impl,salt,init]}))};
 };
 const state=async(registry:Address,label:string)=>{
  const id=BigInt(labelhash(label)),token=await c.readContract({address:registry,abi:registryAbi,functionName:'getTokenId',args:[id]});
  const [status,owner,expiry]=await Promise.all([c.readContract({address:registry,abi:registryAbi,functionName:'getStatus',args:[id]}),c.readContract({address:registry,abi:registryAbi,functionName:'ownerOf',args:[token]}),c.readContract({address:registry,abi:registryAbi,functionName:'getExpiry',args:[id]})]);
  return {status:Number(status),owner,expiry};
 };
 const root=async()=>{
  const s=await state(ENS.registry,rootLabel);
  if(s.status!==2||!same(s.owner,account.address)||s.expiry<=(await c.getBlock()).timestamp)blocked('The sponsored ENS root is not ready.');
  const registry=await c.readContract({address:ENS.registry,abi:subregistryAbi,functionName:'getSubregistry',args:[rootLabel]});
  if(registry===zeroAddress)blocked('The ENS root subregistry is not ready.');
  return {...s,registry};
 };
 const execute=async(input:unknown)=>{
  const a=input as {profileId?:unknown;wallet?:unknown};
  if(!a||typeof a.wallet!=='string'||typeof a.profileId!=='string')throw new ApiError(400,'invalid','Invalid trader ENS request.');
  const p=(await o.profiles()).find(p=>p.id===a.profileId&&same(p.owner,a.wallet as string));
  if(!p)throw new ApiError(403,'not_owner','Only the trader owner may request this name.');
  const label=traderLabel(p.id),name=`${label}.${rootName}`,parent=await root();
  const salt=BigInt(keccak256(toHex(`swipr-resolver:${name}:${p.owner.toLowerCase()}`))),resolver=await predicted(salt);
  const existing=await state(parent.registry,label);
  if(existing.status!==0&&(!same(existing.owner,p.owner)||existing.status!==2))blocked('This trader subname belongs to another owner or has expired.');
  const records=await o.snapshot(p.id);
  if(!await hasCode(resolver)){
   const calls=[60n,2147492101n].map(coin=>encodeFunctionData({abi:resolverAbi,functionName:'setAddress',args:[dnsName(name),coin,p.owner as Address]}));
   for(const [key,value] of Object.entries({...records,'swipr.updatedAt':new Date().toISOString()}))calls.push(encodeFunctionData({abi:resolverAbi,functionName:'setText',args:[dnsName(name),key,value]}));
   const init=encodeFunctionData({abi:resolverAbi,functionName:'initialize',args:[[{account:p.owner as Address,roleBitmap:ALL},{account:account.address,roleBitmap:ALL}],calls]});
   return {name,state:'pending',stage:'resolver',txHash:(await deploy(ENS.resolverImpl,salt,init)).txHash};
  }
  const roles=await c.readContract({address:resolver,abi:resolverAbi,functionName:'roles',args:[0n,account.address]});
  if(roles!==0n){
   const calls=KEYS.map(key=>encodeFunctionData({abi:resolverAbi,functionName:'grantSetterRoles',args:[encodeFunctionData({abi:resolverAbi,functionName:'setText',args:['0x',key,'']}),account.address]}));
   calls.push(encodeFunctionData({abi:resolverAbi,functionName:'revokeRootRoles',args:[ALL,account.address]}));
   return {name,state:'pending',stage:'permissions',txHash:await send(resolver,encodeFunctionData({abi:resolverAbi,functionName:'multicall',args:[calls]}))};
  }
  if(existing.status===0)return {name,state:'pending',stage:'subname',txHash:await send(parent.registry,encodeFunctionData({abi:subregistryAbi,functionName:'register',args:[label,p.owner as Address,zeroAddress,resolver,OWNER_ROLES,parent.expiry]}))};
  const [actualResolver]=await c.readContract({address:ENS.universal,abi:universalAbi,functionName:'findResolver',args:[dnsName(name)]});
  if(!same(actualResolver,resolver))blocked('The owner changed the resolver. Swipr will not override it.');
  const text=async(key:string)=>{const [out]=await c.readContract({address:ENS.universal,abi:universalAbi,functionName:'resolve',args:[dnsName(name),encodeFunctionData({abi:profileAbi,functionName:'text',args:[namehash(name),key]})]});return decodeFunctionResult({abi:profileAbi,functionName:'text',data:out});};
  const [profile,stats,updatedAt]=await Promise.all(KEYS.map(text));
  if(profile===records['swipr.profile']&&stats===records['swipr.stats']&&Date.parse(updatedAt)<=Date.now()+60000&&Date.now()-Date.parse(updatedAt)<300000)return {name,state:'ready',owner:p.owner,resolver};
  const calls=Object.entries({...records,'swipr.updatedAt':new Date().toISOString()}).filter(([key])=>KEYS.includes(key)).map(([key,value])=>encodeFunctionData({abi:resolverAbi,functionName:'setText',args:[dnsName(name),key,value]}));
  try{return {name,state:'pending',stage:'records',txHash:await send(resolver,encodeFunctionData({abi:resolverAbi,functionName:'multicall',args:[calls]}))};}
  catch{blocked('ENS publication could not be confirmed. The owner may have revoked publishing permission.');}
 };
 return {
  address:account.address,nameFor:(profileId:string)=>`${traderLabel(profileId)}.${rootName}`,
  execute(input:unknown){const result=queue.then(()=>execute(input));queue=result.then(()=>{},()=>{});return result;},
  /** Operator-only bootstrap, never exposed through HTTP. Exactly one platform root, no trader registration fee. */
  async bootstrap(){
   const rootState=await state(ENS.registry,rootLabel);
   if(rootState.status!==0&&!same(rootState.owner,account.address))blocked('The ENS root is owned by another wallet.');
   const salt=BigInt(keccak256(toHex(`swipr-root:${rootName}`))),init=encodeFunctionData({abi:subregistryAbi,functionName:'initialize',args:[[{account:account.address,roleBitmap:ALL}]]});
   const d=await deploy(ENS.registryImpl,salt,init);if(d.txHash)return {stage:'root-registry',txHash:d.txHash};
   if(rootState.status===2){
    const registry=await c.readContract({address:ENS.registry,abi:subregistryAbi,functionName:'getSubregistry',args:[rootLabel]});
    if(registry!==d.address)return {stage:'attach-root',txHash:await send(ENS.registry,encodeFunctionData({abi:subregistryAbi,functionName:'setSubregistry',args:[BigInt(labelhash(rootLabel)),d.address]}))};
    return {stage:'ready',name:rootName,registry};
   }
   const tokenAbi=parseAbi(['function balanceOf(address) view returns (uint256)','function allowance(address,address) view returns (uint256)','function mint(address,uint256)','function approve(address,uint256) returns (bool)']);
   if(await c.readContract({address:ENS.paymentToken,abi:tokenAbi,functionName:'balanceOf',args:[account.address]})<100000000n)return {stage:'test-currency',txHash:await send(ENS.paymentToken,encodeFunctionData({abi:tokenAbi,functionName:'mint',args:[account.address,100000000n]}))};
   if(await c.readContract({address:ENS.paymentToken,abi:tokenAbi,functionName:'allowance',args:[account.address,ENS.registrar]})<100000000n)return {stage:'test-approval',txHash:await send(ENS.paymentToken,encodeFunctionData({abi:tokenAbi,functionName:'approve',args:[ENS.registrar,100000000n]}))};
   const secret=keccak256(toHex(`${o.key}:${rootName}:root-registration`)),args=[rootLabel,account.address,secret,d.address,zeroAddress,YEAR,zeroHash] as const;
   const commitment=await c.readContract({address:ENS.registrar,abi:registrarAbi,functionName:'makeCommitment',args});
   const at=await c.readContract({address:ENS.registrar,abi:registrarAbi,functionName:'commitmentAt',args:[commitment]});
   if(!at)return {stage:'commit',txHash:await send(ENS.registrar,encodeFunctionData({abi:registrarAbi,functionName:'commit',args:[commitment]}))};
   const age=await c.readContract({address:ENS.registrar,abi:registrarAbi,functionName:'MIN_COMMITMENT_AGE'});
   if((await c.getBlock()).timestamp<=at+age)return {stage:'waiting',readyAt:Number(at+age+1n)};
   return {stage:'register-root',txHash:await send(ENS.registrar,encodeFunctionData({abi:registrarAbi,functionName:'register',args:[rootLabel,account.address,secret,d.address,zeroAddress,YEAR,ENS.paymentToken,zeroHash]}))};
  },
 };
}
