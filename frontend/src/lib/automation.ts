import{ExpirationTime}from'@arkiv-network/sdk';
import{encodeFunctionData,erc20Abi,type Hex}from'viem';
import type{Session}from'../auth/Session';
import type{SeatPass}from'../contracts/seats';
import{WalletAutomationSchema,WALLET_PROFILE_PROJECT,walletJson}from'../contracts/wallet-profile';
import{accountRequest,arkivConnection,fundArkivWrite}from'./arkiv';
export type AutomationGrant={entityKey?:string;wallet:string;walletId:string;seatId:string;policyId:string;signerId:string;vault:string;expiresAt:number;entries?:boolean;exitLimits?:Partial<Record<'WETH'|'cbBTC',string>>;active?:boolean};
export const readAutomation=(session:Session):Promise<{grants:AutomationGrant[];configured:boolean;signerId?:string}>=>accountRequest(session,`/api/automation?wallet=${session.address}`);
export async function enableAutomation(session:Session,seat:SeatPass,progress:(message:string)=>void,withExits=false){
 const grant=await accountRequest(session,'/api/automation/prepare',{wallet:session.address,seatId:seat.id,...(withExits?{exits:true}:{})}) as AutomationGrant;
 if(grant.wallet!==session.address?.toLowerCase()||grant.seatId!==seat.id||grant.expiresAt!==seat.expiresAt+(withExits?7*86400000:0)||withExits!==!!grant.exitLimits)throw Error('These permissions belong to another pass.');
 const {address,provider}=await session.getBaseWallet();
 if(address.toLowerCase()!==grant.wallet)throw Error('Your account changed.');
 const approvals:{assetAddress:Hex;cap:bigint;symbol:string}[]=[];
 if(!withExits||grant.entries===true)approvals.push({assetAddress:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',cap:BigInt(seat.terms.perTradeUsd*seat.terms.tradeCount)*1000000n,symbol:'USDC'});
 if(withExits){
  if(!grant.exitLimits||!Object.keys(grant.exitLimits).length)throw Error('No current holdings were authorized.');
  for(const [symbol,amount] of Object.entries(grant.exitLimits)){
   if(!['WETH','cbBTC'].includes(symbol)||!amount||!/^[1-9]\d{0,29}$/.test(amount))throw Error('Invalid exit limit.');
   approvals.push({assetAddress:symbol==='WETH'?'0x4200000000000000000000000000000000000006':'0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',cap:BigInt(amount),symbol});
  }
 }
 for(const {assetAddress,cap,symbol} of approvals){
  const allowance=await provider.request({method:'eth_call',params:[{to:assetAddress,data:encodeFunctionData({abi:erc20Abi,functionName:'allowance',args:[address,'0x5d00000873b6BF41539e6f5365B0Ff7d3c368f78']})},'latest']});
  if(BigInt(allowance as Hex)===cap)continue;
  progress(`Review the bounded ${symbol} approval in your wallet.`);
  const hash=await provider.request({method:'eth_sendTransaction',params:[{from:address,to:assetAddress,value:'0x0',data:encodeFunctionData({abi:erc20Abi,functionName:'approve',args:['0x5d00000873b6BF41539e6f5365B0Ff7d3c368f78',cap]})}]});
  let confirmed=false;
  for(let i=0;i<60;i++){
   if(session.address?.toLowerCase()!==grant.wallet)throw Error('Your account changed.');
   const receipt=await provider.request({method:'eth_getTransactionReceipt',params:[hash as Hex]}) as {status?:string;blockNumber?:string}|null;
   if(receipt?.status==='0x0')throw Error('Approval failed.');
   if(receipt?.status==='0x1'&&receipt.blockNumber){const head=await provider.request({method:'eth_blockNumber'});if(BigInt(head as string)-BigInt(receipt.blockNumber)>=1n){confirmed=true;break;}}
   await new Promise(r=>setTimeout(r,2000));
  }
  if(!confirmed)throw Error('Approval remains pending. Automatic copying has not been enabled.');
 }
 progress(withExits?'Approve exits for these holdings. Proceeds stay in your wallet; permission ends seven days after the pass.':'Approve the bounded copy permission in your wallet.');
 try {
 await session.addSigner(grant.signerId,grant.policyId);
 progress('Saving your wallet-owned permission…');
 const {client,address:arkiv}=await arkivConnection(session);
 if(arkiv.toLowerCase()!==grant.wallet)throw Error('Your account changed.');
 await fundArkivWrite(session,arkiv);
 const saved=await client.createEntity(WalletAutomationSchema,{project:WALLET_PROFILE_PROJECT,grant:walletJson(grant)},{expiration:ExpirationTime.fromDays(90),flags:{readonly:true}});
 await client.waitForTransactionReceipt({hash:saved.txHash,confirmations:2});
 for(let i=0;i<15;i++){
  const state=await readAutomation(session);
  if(state.grants.some(g=>g.entityKey===saved.entityKey&&g.active))return saved;
  await new Promise(r=>setTimeout(r,2000));
 }
 throw Error('The permission has not been confirmed.');
 }catch(error){
  try{await session.removeSigner(grant.signerId);}catch{throw Error('Setup did not finish. Use Stop automatic copying to revoke the pending permission.');}
  throw error;
 }
}
export async function stopAutomation(session:Session,seatId:string){
 const state=await readAutomation(session);
 if(state.signerId)await session.removeSigner(state.signerId);
 const rows=state.grants.filter(g=>g.seatId===seatId);
 for(const g of rows){
  if(g.signerId!==state.signerId)await session.removeSigner(g.signerId);
  if(!g.entityKey)continue;
  const {client,reader,address}=await arkivConnection(session),record=await reader.getEntity(g.entityKey as Hex);
  if(record.$owner.toLowerCase()!==address.toLowerCase())throw Error('Permission belongs to another wallet.');
  await fundArkivWrite(session,address);const result=await client.deleteEntity({entityKey:g.entityKey as Hex});
  await client.waitForTransactionReceipt({hash:result.txHash,confirmations:2});
 }
}
