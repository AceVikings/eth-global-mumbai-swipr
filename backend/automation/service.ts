import{createHash}from'node:crypto';
import{recoverTypedDataAddress,type Hex}from'viem';
import{ApiError,type Identity}from'../auth';
import type{BotProfile}from'../contracts/bots';
import type{SeatPass,SeatDirectory}from'../contracts/seats';
import type{TradingService}from'../trading/service';
import{createFlashClient,TOKENS,validateTypedData,SWIPR_INTEGRATOR_FEE_BPS}from'../providers/flash';
import{copyPolicy,canonical,comparableRules}from'./policy';
import{parseGrant,type Grant}from'./grants';
import{createPrivyControl}from'./privy';
export function createAutomation(options:{control:ReturnType<typeof createPrivyControl>;signerId:string;trades:TradingService;flash:ReturnType<typeof createFlashClient>;
 profiles:()=>Promise<BotProfile[]>;seats:(wallet:string,profiles:BotProfile[])=>Promise<SeatDirectory>;grants:()=>Promise<Grant[]>}){
 const {control,trades}=options;
 const source=async(seat:SeatPass)=>{
  const orders=await options.flash.listOrders(seat.traderOwner);
  for(const item of orders.orders){
   const id=item.orderId??item.id;if(!id)continue;
   const {raw}=await options.flash.getOrder(id,seat.traderOwner),row=(raw as {order?:Record<string,any>}).order;
   const asset=(['WETH','cbBTC']as const).find(a=>TOKENS[a].address.toLowerCase()===row?.targetAsset?.address?.toLowerCase());
   if(row?.side!=='buy'||row?.orderType!=='limit'||Date.parse(row.expiresAt)<=Date.now()||!asset)continue;
   // This is the same receipt and source-window verifier used for tap copies.
   try{return await trades.quote(seat.owner,{profileId:seat.traderId,seatId:seat.id,sourceOrderId:id,asset,qty:'5'});}catch{/* no confirmed fill yet */}
  }
  return null;
 };
 const check=async(g:Grant,seat:SeatPass)=>{
  const wallet=await control.request(`/wallets/${g.walletId}`);
  if(wallet.address?.toLowerCase()!==seat.owner||g.wallet!==seat.owner||g.seatId!==seat.id||g.expiresAt!==seat.expiresAt||g.signerId!==options.signerId)throw Error('Wallet permission mismatch.');
  const signer=wallet.additional_signers?.find((s:any)=>s.signer_id===g.signerId);
  if(!signer||canonical(signer.override_policy_ids??[])!==canonical([g.policyId]))throw Error('This signer is not enabled.');
  const policy=await control.request(`/policies/${g.policyId}`),expected=copyPolicy(seat,g.vault);
  if(policy.version!==expected.version||policy.chain_type!==expected.chain_type||canonical(comparableRules(policy.rules))!==canonical(comparableRules(expected.rules)))throw Error('Wallet policy does not match this pass.');
 };
 return{
  async signers(identity:Identity,wallet:string){
   const user=await control.request(`/users/${encodeURIComponent(identity.userId)}`);
   const linked=user.linked_accounts?.find((a:any)=>a.type==='wallet'&&a.wallet_client_type==='privy'&&a.address?.toLowerCase()===wallet&&a.id);
   if(!linked)throw new ApiError(409,'embedded_wallet_required','Use your embedded wallet.');
   const record=await control.request(`/wallets/${linked.id}`);
   if(record.address?.toLowerCase()!==wallet||!Array.isArray(record.additional_signers))throw Error('Wallet permissions unavailable.');
   return {walletId:linked.id,signers:record.additional_signers.map((s:any)=>({signer_id:s.signer_id,override_policy_ids:s.override_policy_ids??[]}))};
  },
  async state(wallet:string){
   const profiles=await options.profiles(),directory=await options.seats(wallet,profiles),rows=[];
   for(const grant of (await options.grants()).filter(g=>g.wallet===wallet)){
    const seat=directory.passes.find(p=>p.id===grant.seatId&&p.owner===wallet&&p.status==='joined');
    let active=false;try{if(seat&&grant.expiresAt>Date.now()){await check(grant,seat);active=true;}}catch{}
    rows.push({...grant,active});
   }
   return {grants:rows};
  },
  async prepare(identity:Identity,wallet:string,seatId:string){
   const profiles=await options.profiles(),directory=await options.seats(wallet,profiles);
   const seat=directory.passes.find(p=>p.id===seatId&&p.owner===wallet&&p.status==='joined');
   if(!seat||seat.terms.mode!=='auto'||seat.budgetVersion!==1)throw new ApiError(409,'permission_required','Join a current auto-copy pass first.');
   const existing=(await options.grants()).filter(g=>g.wallet===wallet&&g.expiresAt>Date.now());
   if(existing.some(g=>g.seatId!==seatId))throw new ApiError(409,'permission_required','Stop your other automatic pass before enabling this one.');
   // Permission setup is independent of a trader's short copy window. This unsigned
   // authenticated sell quote only discovers Flash's vault. It is never signed;
   // the resulting policy permits only buys and the worker still requires a fill.
   const intent={side:'sell' as const,asset:'WETH' as const,qty:'0.002',funder:wallet,orderType:'market' as const,maxPriceImpact:'0.01',integratorFeeBps:SWIPR_INTEGRATOR_FEE_BPS};
   const quote=await options.flash.quote(intent);
   validateTypedData(quote.typedData,intent,{now:Math.floor(Date.now()/1000),maxDeadline:Math.floor(Date.now()/1000)+900,expectedVault:String(quote.typedData.message.vault)});
   const user=await control.request(`/users/${encodeURIComponent(identity.userId)}`);
   const linked=user.linked_accounts?.find((a:any)=>a.type==='wallet'&&a.wallet_client_type==='privy'&&a.address?.toLowerCase()===wallet&&a.id);
   if(!linked)throw new ApiError(409,'embedded_wallet_required','Automatic copying needs your embedded wallet.');
   const vault=String(quote.typedData.message.vault),policy=copyPolicy(seat,vault);
   const key=createHash('sha256').update(`${wallet}:${seatId}:${canonical(policy)}`).digest('hex');
   const created=await control.request('/policies',{...policy,owner:{user_id:identity.userId}},key);
   return parseGrant({wallet,walletId:linked.id,seatId,policyId:created.id,signerId:options.signerId,vault,expiresAt:seat.expiresAt});
  },
  async tick(){
   const profiles=await options.profiles(),grants=await options.grants();
   const result={checked:0,submitted:0,failed:0};
   for(const g of grants){
    result.checked++;
    try{
     if(g.expiresAt<=Date.now())continue;
     const seat=(await options.seats(g.wallet,profiles)).passes.find(p=>p.id===g.seatId&&p.owner===g.wallet&&p.status==='joined');
     if(!seat||seat.terms.mode!=='auto')continue;
     await check(g,seat);
     const quote=await source(seat);if(!quote||String(quote.typedData.message.vault).toLowerCase()!==g.vault.toLowerCase())continue;
     await trades.preflight(g.wallet,quote.ticket);
     const td=quote.typedData;
     const signed=await control.request(`/wallets/${g.walletId}/rpc`,{method:'eth_signTypedData_v4',params:{typed_data:{domain:td.domain,types:td.types,primary_type:td.primaryType,message:td.message}}},quote.quoteId,true);
     const signature=signed.data?.signature;
     if(typeof signature!=='string'||(await recoverTypedDataAddress({...td,signature:signature as Hex} as any)).toLowerCase()!==g.wallet)throw Error('Wrong permission signer.');
     await trades.submit(g.wallet,quote.ticket,signature);result.submitted++;
    }catch{result.failed++;/* Never log keys, signatures or provider payloads. */}
   }
   return result;
  },
 };
}
