import {beforeEach,expect,it,vi} from 'vitest';
import {privateKeyToAccount} from 'viem/accounts';
import {createAutomation} from './service';
import {copyPolicy} from './policy';
import {DEFAULT_TERMS} from '../contracts/types';
import {FLASH_DOMAIN,FLASH_DOMAIN_TYPES,FLASH_ORDER_TYPES,TOKENS} from '../providers/flash';
const account=privateKeyToAccount(`0x${'22'.repeat(32)}`),wallet=account.address.toLowerCase();
const seat={id:`0x${'11'.repeat(32)}`,owner:wallet,traderId:`0x${'33'.repeat(32)}`,traderOwner:`0x${'44'.repeat(20)}`,status:'joined',budgetVersion:1,expiresAt:Date.now()+300000,terms:{...DEFAULT_TERMS,mode:'auto',safetyNetBps:0,liquidateOnBreakup:false}} as any;
const grant={wallet,walletId:'wallet123456',seatId:seat.id,policyId:'policy123456',signerId:'signer123456',vault:`0x${'55'.repeat(20)}`,expiresAt:seat.expiresAt};
const td={domain:FLASH_DOMAIN,types:{EIP712Domain:FLASH_DOMAIN_TYPES,FlashOrder:FLASH_ORDER_TYPES},primaryType:'FlashOrder',message:{vault:grant.vault,swapper:wallet,recipient:wallet,fromToken:TOKENS.USDC.address,toToken:TOKENS.WETH.address,fromAmount:'5000000',salt:'1',deadline:String(Math.floor(seat.expiresAt/1000))}};
let currentSeat:any,currentGrant:any,policy:any,signers:any,quote:any;
const passState=vi.fn(),passExit=vi.fn(),submit=vi.fn(),preflight=vi.fn(),quoteFn=vi.fn(),request=vi.fn();
const build=()=>createAutomation({control:{request,publicKey:null},signerId:grant.signerId,trades:{quote:quoteFn,preflight,submit,passState,passExit} as any,
 flash:{quote:async()=>({...quote,typedData:{...td,message:{...td.message,fromToken:TOKENS.WETH.address,toToken:TOKENS.USDC.address,fromAmount:'2000000000000000'}}}),listOrders:async()=>({orders:[{orderId:'source'}]}),getOrder:async()=>({raw:{order:{side:'buy',orderType:'limit',expiresAt:new Date(Date.now()+60000).toISOString(),targetAsset:{address:TOKENS.WETH.address}}}})} as any,
 profiles:async()=>[],seats:async()=>({passes:currentSeat?[currentSeat]:[],invitations:[],availability:[]}),grants:async()=>currentGrant?[currentGrant]:[]});
beforeEach(()=>{
 vi.resetAllMocks();currentSeat=structuredClone(seat);currentGrant={...grant};policy=copyPolicy(currentSeat,grant.vault);
 policy.rules=policy.rules.map((r:any)=>({...r,id:'provider-generated-rule',conditions:r.conditions.map((c:any)=>({...c,value:['swapper','recipient'].includes(c.field)?account.address:c.value}))}));
 signers=[{signer_id:grant.signerId,override_policy_ids:[grant.policyId]}];
 quote={ticket:'ticket',quoteId:'quote',typedData:td};quoteFn.mockResolvedValue(quote);submit.mockResolvedValue({orderId:'copy'});
 request.mockImplementation(async(path:string)=>{
  if(path===`/wallets/${grant.walletId}`)return {address:wallet,additional_signers:signers};
  if(path===`/policies/${grant.policyId}`)return policy;
  if(path.startsWith('/users/'))return {linked_accounts:[{id:grant.walletId,type:'wallet',wallet_client_type:'privy',address:wallet}]};
  if(path==='/policies')return {id:grant.policyId};
  if(path.endsWith('/rpc'))return {data:{signature:await account.signTypedData(td as never)}};
  throw Error('Unexpected request');
 });
});
it('signs and submits only after native ownership, signer policy and preflight are verified',async()=>{
 expect(await build().tick()).toEqual({checked:1,submitted:1,failed:0});
 expect(preflight).toHaveBeenCalledWith(wallet,'ticket');expect(submit).toHaveBeenCalledOnce();
 expect(request.mock.calls.find(([p])=>p.endsWith('/rpc'))?.[3]).toBe(true);
});
it.each(['missing grant','expired grant','revoked seat','revoked signer','wrong policy','wrong vault','no funds','already copied'] as const)('does not sign when %s',async scenario=>{
 if(scenario==='missing grant')currentGrant=null;
 if(scenario==='expired grant')currentGrant.expiresAt=0;
 if(scenario==='revoked seat')currentSeat=null;
 if(scenario==='revoked signer')signers=[];
 if(scenario==='wrong policy')policy={...policy,rules:[]};
 if(scenario==='wrong vault')quote={...quote,typedData:{...td,message:{...td.message,vault:`0x${'66'.repeat(20)}`}}};
 if(scenario==='no funds')preflight.mockRejectedValue(Error('insufficient'));
 if(scenario==='already copied')quoteFn.mockRejectedValue(Error('source already reserved'));
 quoteFn.mockImplementation(async()=>{if(scenario==='already copied')throw Error('already copied');return quote;});
 await build().tick();expect(submit).not.toHaveBeenCalled();expect(request.mock.calls.some(([p])=>p.endsWith('/rpc'))).toBe(false);
});
it('does not relay a provider signature from a different wallet',async()=>{
 const other=privateKeyToAccount(`0x${'77'.repeat(32)}`);
 request.mockImplementationOnce(async()=>({address:wallet,additional_signers:signers}))
  .mockImplementationOnce(async()=>policy)
  .mockImplementationOnce(async()=>({data:{signature:await other.signTypedData(td as never)}}));
 expect((await build().tick()).failed).toBe(1);expect(submit).not.toHaveBeenCalled();
});
it('creates an owner-controlled policy and refuses unsupported or competing passes',async()=>{
 const identity={userId:'did:privy:test',wallets:[wallet]};const service=build();
 expect(await service.prepare(identity,wallet,seat.id)).toMatchObject(grant);
 const policyCall=request.mock.calls.find(([p])=>p==='/policies');expect(policyCall?.[1].owner).toEqual({user_id:identity.userId});
 currentGrant.seatId=`0x${'88'.repeat(32)}`;
 await expect(service.prepare(identity,wallet,seat.id)).rejects.toThrow('other automatic pass');
 currentGrant=null;currentSeat.terms.mode='tap';
 await expect(service.prepare(identity,wallet,seat.id)).rejects.toThrow('current auto-copy pass');
});
it('preserves unrelated signers in the owner-authorized revocation snapshot',async()=>{
 signers.push({signer_id:'unrelated123',override_policy_ids:['otherpolicy123']});
 expect(await build().signers({userId:'did:privy:test',wallets:[wallet]},wallet)).toEqual({walletId:grant.walletId,signers});
});

it('can prepare permissions before a fresh trader order without signing or submitting a trade',async()=>{
 quoteFn.mockRejectedValue(Error('no trader fill'));
 expect(await build().prepare({userId:'did:privy:test',wallets:[wallet]},wallet,seat.id)).toMatchObject(grant);
 expect(submit).not.toHaveBeenCalled();expect(preflight).not.toHaveBeenCalled();expect(request.mock.calls.some(([p])=>p.endsWith('/rpc'))).toBe(false);
});

it('uses an explicitly approved exit scope after entry expiry without opening a new buy',async()=>{
 currentSeat.expiresAt=Date.now()-60000;currentSeat.status='expired';
 currentGrant={...grant,expiresAt:currentSeat.expiresAt+7*86400000,exitLimits:{WETH:'2000000000000000'}};
 policy=copyPolicy(currentSeat,grant.vault,currentGrant.exitLimits,currentGrant.entries===true);
 const sell={...td,message:{...td.message,fromToken:TOKENS.WETH.address,toToken:TOKENS.USDC.address,fromAmount:'1000000000000000',deadline:String(Math.floor(Date.now()/1000)+600)}};
 passState.mockResolvedValue({plans:[{asset:'WETH',units:'1000000000000000',reason:'cashout'}]});
 passExit.mockResolvedValue({...quote,typedData:sell});
 request.mockImplementation(async(path:string)=>{
  if(path===`/wallets/${grant.walletId}`)return {address:wallet,additional_signers:signers};
  if(path===`/policies/${grant.policyId}`)return policy;
  if(path.endsWith('/rpc'))return {data:{signature:await account.signTypedData(sell as never)}};
  throw Error('Unexpected request');
 });
 expect(await build().tick()).toEqual({checked:1,submitted:1,failed:0});
 expect(passExit).toHaveBeenCalledWith(wallet,seat.id,'WETH','cashout');expect(quoteFn).not.toHaveBeenCalled();
});
it('does not sign an exit larger than the owner-approved holdings',async()=>{
 currentGrant={...grant,expiresAt:currentSeat.expiresAt+7*86400000,exitLimits:{WETH:'1'}};
 policy=copyPolicy(currentSeat,grant.vault,currentGrant.exitLimits,currentGrant.entries===true);
 currentSeat.status='expired';
 passState.mockResolvedValue({plans:[{asset:'WETH',units:'2',reason:'stop'}]});
 await build().tick();expect(passExit).not.toHaveBeenCalled();expect(submit).not.toHaveBeenCalled();
});
