import {beforeEach,expect,it,vi} from 'vitest';
import {enableAutomation,stopAutomation} from './automation';
const f=vi.hoisted(()=>({request:vi.fn(),connection:vi.fn(),fund:vi.fn(),create:vi.fn(),wait:vi.fn(),get:vi.fn(),remove:vi.fn()}));
vi.mock('./arkiv',()=>({accountRequest:f.request,arkivConnection:f.connection,fundArkivWrite:f.fund}));
const wallet=`0x${'22'.repeat(20)}`,seat={id:`0x${'11'.repeat(32)}`,expiresAt:1800000000000,terms:{perTradeUsd:5,tradeCount:1}} as any;
const grant={wallet,seatId:seat.id,expiresAt:seat.expiresAt,signerId:'signer123456',policyId:'policy123456',entityKey:`0x${'33'.repeat(32)}`};
const provider={request:vi.fn()},addSigner=vi.fn(),removeSigner=vi.fn();
const session={address:wallet,getBaseWallet:async()=>({address:wallet,provider}),addSigner,removeSigner} as any;
beforeEach(()=>{
 vi.resetAllMocks();
 f.request.mockImplementation(async(_session,path)=>path.endsWith('/prepare')?grant:{grants:[{...grant,active:true}],configured:true,signerId:grant.signerId});
 provider.request.mockImplementation(async({method})=>method==='eth_sendTransaction'?`0x${'44'.repeat(32)}`:method==='eth_getTransactionReceipt'?{status:'0x1',blockNumber:'0x1'}:'0x2');
 f.create.mockResolvedValue({entityKey:grant.entityKey,txHash:`0x${'55'.repeat(32)}`});
 f.get.mockResolvedValue({$owner:wallet});f.remove.mockResolvedValue({txHash:`0x${'66'.repeat(32)}`});
 f.connection.mockResolvedValue({address:wallet,client:{createEntity:f.create,deleteEntity:f.remove,waitForTransactionReceipt:f.wait},reader:{getEntity:f.get}});
});
it('shows active only after provider permission and indexed wallet-owned grant are confirmed',async()=>{
 await enableAutomation(session,seat,()=>{});expect(addSigner).toHaveBeenCalledWith(grant.signerId,grant.policyId);
 expect(f.create).toHaveBeenCalledOnce();expect(removeSigner).not.toHaveBeenCalled();
});
it('never grants a signer when token approval is declined',async()=>{
 provider.request.mockRejectedValue(Error('declined'));
 await expect(enableAutomation(session,seat,()=>{})).rejects.toThrow('declined');expect(addSigner).not.toHaveBeenCalled();expect(f.create).not.toHaveBeenCalled();
});
it('revokes a permission when saving its native grant fails',async()=>{
 f.create.mockRejectedValue(Error('storage failed'));
 await expect(enableAutomation(session,seat,()=>{})).rejects.toThrow('storage failed');expect(removeSigner).toHaveBeenCalledWith(grant.signerId);
});
it('attempts revocation even if adding a signer has an uncertain outcome',async()=>{
 addSigner.mockRejectedValue(Error('response lost'));
 await expect(enableAutomation(session,seat,()=>{})).rejects.toThrow('response lost');expect(removeSigner).toHaveBeenCalledWith(grant.signerId);
});
it('revokes authority before deleting the grant and retains recovery if revocation fails',async()=>{
 removeSigner.mockRejectedValue(Error('declined'));
 await expect(stopAutomation(session,seat.id)).rejects.toThrow('declined');expect(f.remove).not.toHaveBeenCalled();
});
it('can revoke a pending permission even when no native grant was indexed',async()=>{
 f.request.mockResolvedValue({grants:[],configured:true,signerId:grant.signerId});await stopAutomation(session,seat.id);
 expect(removeSigner).toHaveBeenCalledWith(grant.signerId);expect(f.remove).not.toHaveBeenCalled();
});
it('refuses a grant prepared for a different wallet before any approval',async()=>{
 f.request.mockResolvedValue({...grant,wallet:`0x${'77'.repeat(20)}`});
 await expect(enableAutomation(session,seat,()=>{})).rejects.toThrow('another pass');expect(provider.request).not.toHaveBeenCalled();
});

it('reuses the exact existing pass allowance without another approval transaction',async()=>{
 const original=provider.request.getMockImplementation()!;
 provider.request.mockImplementation(async args=>args.method==='eth_call'?'0x4c4b40':original(args));
 await enableAutomation(session,seat,()=>{});
 expect(provider.request.mock.calls.some(([args])=>args.method==='eth_sendTransaction')).toBe(false);
 expect(addSigner).toHaveBeenCalledOnce();
});
it('requires explicit exit scope and approves only its bounded current holdings',async()=>{
 const scoped={...grant,expiresAt:seat.expiresAt+7*86400000,exitLimits:{WETH:'2000000000000000'}};
 f.request.mockImplementation(async(_s,path)=>path.endsWith('/prepare')?scoped:{grants:[{...scoped,active:true}],configured:true});
 await enableAutomation(session,{...seat,terms:{...seat.terms,mode:'tap'}},()=>{},true);
 const calls=provider.request.mock.calls.filter(([a])=>a.method==='eth_sendTransaction');
 expect(calls).toHaveLength(1);expect(calls[0][0].params[0].to).toBe('0x4200000000000000000000000000000000000006');
 expect(f.request.mock.calls[0][2]).toMatchObject({exits:true});
});
