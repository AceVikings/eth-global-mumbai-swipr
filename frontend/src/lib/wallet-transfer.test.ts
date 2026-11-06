import {beforeEach,expect,it,vi} from 'vitest';
import {decodeFunctionData,erc20Abi,getAddress} from 'viem';
import {prepareUsdcTransfer,sendUsdc} from './wallet-transfer';
const owner=getAddress(`0x${'11'.repeat(20)}`),recipient=`0x${'22'.repeat(20)}`,hash=`0x${'33'.repeat(32)}`;
const request=vi.fn(),session={address:owner,getBaseWallet:async()=>({address:owner,provider:{request}})} as any;
beforeEach(()=>{
 vi.resetAllMocks();request.mockImplementation(async({method})=>{
  if(method==='eth_chainId')return '0x2105';if(method==='eth_call')return '0x4c4b40';
  if(method==='eth_sendTransaction')return hash;if(method==='eth_getTransactionReceipt')return {status:'0x1',blockNumber:'0x1'};
  if(method==='eth_blockNumber')return '0x2';if(method==='eth_getTransactionByHash')return {...prepareUsdcTransfer(owner,recipient,'0.1'),input:prepareUsdcTransfer(owner,recipient,'0.1').data};
  throw Error('Unexpected RPC');
 });
});
it('binds recipient, exact USDC units and Base with no native value',()=>{
 const plan=prepareUsdcTransfer(owner,recipient,'0.1');expect(plan).toMatchObject({from:owner,chainId:'0x2105',value:'0x0'});
 expect(decodeFunctionData({abi:erc20Abi,data:plan.data})).toMatchObject({functionName:'transfer',args:[recipient,100000n]});
});
it.each(['0','-1','5.01','0.0000001','1e2'])('rejects an invalid or oversized amount %s',amount=>{
 expect(()=>prepareUsdcTransfer(owner,recipient,amount)).toThrow();
});
it('rejects zero, self and malformed recipients',()=>{
 for(const to of ['0x'+'00'.repeat(20),owner,'invalid'])expect(()=>prepareUsdcTransfer(owner,to,'0.1')).toThrow();
});
it('sends once and confirms the exact transaction after two confirmations',async()=>{
 expect(await sendUsdc(session,recipient,'0.1',()=>{},new AbortController().signal)).toBe(hash);
 expect(request.mock.calls.filter(([r])=>r.method==='eth_sendTransaction')).toHaveLength(1);
});
it('refuses another network before a send',async()=>{
 request.mockResolvedValueOnce('0x1');await expect(sendUsdc(session,recipient,'0.1',()=>{},new AbortController().signal)).rejects.toThrow('Base');
 expect(request.mock.calls.some(([r])=>r.method==='eth_sendTransaction')).toBe(false);
});
it('marks an unknown submission as uncertain and never retries it',async()=>{
 request.mockImplementation(async({method})=>{if(method==='eth_chainId')return '0x2105';if(method==='eth_call')return '0x4c4b40';throw Error('response lost');});
 await expect(sendUsdc(session,recipient,'0.1',()=>{},new AbortController().signal)).rejects.toMatchObject({uncertain:true});
 expect(request.mock.calls.filter(([r])=>r.method==='eth_sendTransaction')).toHaveLength(1);
});
it('rejects insufficient token balance and an account switch before sending',async()=>{
 request.mockResolvedValueOnce('0x2105').mockResolvedValueOnce('0x0');
 await expect(sendUsdc(session,recipient,'0.1',()=>{},new AbortController().signal)).rejects.toThrow('Insufficient');
 await expect(sendUsdc({...session,getBaseWallet:async()=>({address:recipient,provider:{request}})},recipient,'0.1',()=>{},new AbortController().signal)).rejects.toThrow('changed');
 expect(request.mock.calls.some(([r])=>r.method==='eth_sendTransaction')).toBe(false);
});
it('never reports a successful receipt for a transaction with different calldata',async()=>{
 const original=request.getMockImplementation()!;
 request.mockImplementation(async args=>args.method==='eth_getTransactionByHash'?{...prepareUsdcTransfer(owner,recipient,'0.1'),input:'0x'}:original(args));
 await expect(sendUsdc(session,recipient,'0.1',()=>{},new AbortController().signal)).rejects.toThrow('differs');
});
