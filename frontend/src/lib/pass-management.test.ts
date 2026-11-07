import { beforeEach, expect, it, vi } from 'vitest';
import { encodeFunctionData, erc20Abi } from 'viem';
import { settlePass } from './pass-management';
const f=vi.hoisted(()=>({trade:vi.fn(),connection:vi.fn(),fund:vi.fn(),query:vi.fn()}));
vi.mock('./trading',()=>({tradeRequest:f.trade}));
vi.mock('./arkiv',()=>({arkivConnection:f.connection,fundArkivWrite:f.fund}));
const owner=`0x${'11'.repeat(20)}`,trader=`0x${'22'.repeat(20)}` as const,seatId=`0x${'33'.repeat(32)}`,hash=`0x${'44'.repeat(32)}`;
const provider={request:vi.fn()},session={address:owner,getBaseWallet:async()=>({address:owner,provider})} as any;
const quote=(amount='100000')=>({seatId,amount,trader,chainId:8453,to:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',data:encodeFunctionData({abi:erc20Abi,functionName:'transfer',args:[trader,BigInt(amount)]}),value:'0x0'});
let storage:Map<string,string>;
beforeEach(()=>{
 vi.resetAllMocks();storage=new Map();vi.stubGlobal('localStorage',{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)});
 provider.request.mockResolvedValue(hash);f.query.mockResolvedValue({entities:[{}]});f.connection.mockResolvedValue({address:owner,reader:{query:f.query}});
 f.trade.mockResolvedValue({settled:true,amount:'100000',txHash:hash});
});
it('pays only the exact reviewed Base USDC transfer and records its hash before verification',async()=>{
 const result=await settlePass(session,quote(),()=>{});expect(result.settled).toBe(true);
 expect(provider.request).toHaveBeenCalledOnce();expect(provider.request.mock.calls[0][0].params[0]).toMatchObject({from:owner,to:quote().to,data:quote().data,value:'0x0',chainId:'0x2105'});
 expect(f.trade.mock.calls[0][2]).toEqual({seatId,txHash:hash});expect(storage.size).toBe(0);
});
it('resumes receipt verification instead of paying again after reload',async()=>{
 storage.set(`swipr.settlement.${owner}.${seatId}`,hash);
 await settlePass(session,quote(),()=>{});expect(provider.request).not.toHaveBeenCalled();
});
it('never pays a waived fee and rejects mismatched tokens or recipients before the wallet opens',async()=>{
 f.trade.mockResolvedValue({settled:true,amount:'0',txHash:null});await settlePass(session,quote('0'),()=>{});expect(provider.request).not.toHaveBeenCalled();
 await expect(settlePass(session,{...quote(),to:trader},()=>{})).rejects.toThrow('Invalid');
 await expect(settlePass(session,{...quote(),trader:owner},()=>{})).rejects.toThrow('reviewed');expect(provider.request).not.toHaveBeenCalled();
});
it('does not report settlement or store a hash when the wallet declines',async()=>{
 provider.request.mockRejectedValue(Error('declined'));await expect(settlePass(session,quote(),()=>{})).rejects.toThrow('declined');expect(f.trade).not.toHaveBeenCalled();expect(storage.size).toBe(0);
});
