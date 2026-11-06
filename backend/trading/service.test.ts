import { beforeEach, expect, it, vi } from 'vitest';
import { encodeFunctionData, erc20Abi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createTradingService } from './service';
import { FLASH_DOMAIN, FLASH_ORDER_TYPES, FLASH_DOMAIN_TYPES, TOKENS } from '../providers/flash';
import type { BotProfile } from '../contracts/bots';
import {DEFAULT_TERMS} from '../contracts/types';
import type { SeatDirectory } from '../contracts/seats';
const chain = vi.hoisted(() => ({ getBlock: vi.fn(), getChainId: vi.fn(), getBalance: vi.fn(), getCode: vi.fn(), getBlockNumber: vi.fn(), getTransactionReceipt: vi.fn(), getTransaction: vi.fn(), readContract: vi.fn() }));
vi.mock('viem', async original => ({ ...await original<typeof import('viem')>(), createPublicClient: () => chain }));
const trader = privateKeyToAccount(`0x${'11'.repeat(32)}`), copier = privateKeyToAccount(`0x${'22'.repeat(32)}`);
const profile = { id: `0x${'ab'.repeat(32)}`, owner: trader.address, operator: trader.address, status: 'active', assets: ['WETH'], name: 'Trader' } as BotProfile;
const vault = `0x${'33'.repeat(20)}`;
let posts: { path: string; body: any }[], sent: number;
const setup = (overrides: Record<string, unknown> = {}, directory: SeatDirectory = { passes: [], availability: [], invitations: [] }) => {
 const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  posts.push({ path: url, body });
  if (url.endsWith('/quote')) return new Response(JSON.stringify({ quoteId: 'quote-1', evm: {
   orderTypedData: JSON.stringify({ domain: FLASH_DOMAIN, types: { FlashOrder: FLASH_ORDER_TYPES, EIP712Domain: FLASH_DOMAIN_TYPES }, primaryType: 'FlashOrder',
    message: { swapper: body.funderAddress, vault, recipient: body.funderAddress, fromToken: TOKENS.USDC.address, toToken: TOKENS.WETH.address,
    fromAmount: '5000000', salt: '1', deadline: String(Math.floor(Date.parse(body.expireTime) / 1000)), ...overrides } }),
   approveTx: { to: TOKENS.USDC.address, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [FLASH_DOMAIN.verifyingContract, 5000000n] }) } }, fees: { estimatedFeeNotional: '0.02' } }));
  if (url.endsWith('/order')) { sent++; return new Response(JSON.stringify({ orderId: 'order-1' })); }
  return new Response(JSON.stringify({ order: { orderId: 'order-1', funderAddress: trader.address, recipientAddress: trader.address, status: 'ACCEPTED' }, fills: [] }));
 });
 return { fetcher, service: createTradingService({ apiKey: 'private-test', ticketSecret: 'test-secret', rpcUrl: 'https://rpc.example.com', profiles: async () => [profile],
  seats: async () => directory, fetcher: fetcher as typeof fetch }) };
};
const input = { profileId: profile.id, asset: 'WETH', qty: '5', sharedPrice: '2500' };
beforeEach(() => {
 vi.resetAllMocks(); chain.getBlock.mockResolvedValue({timestamp: 1800000000n}); posts = []; sent = 0;
 chain.getChainId.mockResolvedValue(8453); chain.getCode.mockImplementation(async ({ address }) => address.toLowerCase() === trader.address.toLowerCase() ? undefined : '0x1234');
 chain.getBalance.mockResolvedValue(1000000000000000n);
 chain.getBlockNumber.mockResolvedValue(100n); chain.readContract.mockResolvedValue(5000000n);
});
it('binds a bounded quote to the owner, exact minimal approval, pair, amount and expiry', async () => {
 const { service } = setup(); const quote = await service.quote(trader.address, input);
 expect(quote.intent.qty).toBe('5'); expect(quote.approval?.amount).toBe('5000000');
 expect(quote.expiresAt).toBeLessThanOrEqual(Math.floor(Date.now()/1000)+300);
 const signature = await trader.signTypedData(quote.typedData as never);
 expect(await service.submit(trader.address, quote.ticket, signature)).toEqual({ orderId: 'order-1' });
 expect(await service.submit(trader.address, quote.ticket, signature)).toEqual({ orderId: 'order-1' });
 expect(sent).toBe(1);
});
it('rejects modified quote tickets, another wallet and another signature before relay', async () => {
 const { service } = setup(); const quote = await service.quote(trader.address, input);
 const signature = await trader.signTypedData(quote.typedData as never);
 await expect(service.submit(trader.address, 'x' + quote.ticket.slice(1), signature)).rejects.toThrow('changed');
 await expect(service.submit(copier.address, quote.ticket, signature)).rejects.toThrow('another wallet');
 await expect(service.submit(trader.address, quote.ticket, await copier.signTypedData(quote.typedData as never))).rejects.toThrow('another wallet');
 expect(sent).toBe(0);
});
it('rejects an unavailable settlement contract or wrong network', async () => {
 const { service } = setup(); chain.getCode.mockResolvedValue(undefined);
 await expect(service.quote(trader.address, input)).rejects.toThrow('settlement contract is unavailable');
 chain.getChainId.mockResolvedValue(1);
 await expect(service.quote(trader.address, input)).rejects.toThrow('network'); expect(sent).toBe(0);
});
it('rejects larger orders, arbitrary copier joins and unlimited deadlines', async () => {
 const { service } = setup();
 await expect(service.quote(trader.address, { ...input, qty: '10' })).rejects.toThrow('5 USDC');
 await expect(service.quote(copier.address, input)).rejects.toThrow('Join');
 await expect(setup({ deadline: '281474976710655' }).service.quote(trader.address, input)).rejects.toThrow('deadline');
 expect(sent).toBe(0);
});
it('rejects a broad allowance or insufficient balance before submission', async () => {
 const { service } = setup(); const quote = await service.quote(trader.address, input); const sig = await trader.signTypedData(quote.typedData as never);
 chain.readContract.mockResolvedValue(2n ** 256n - 1n);
 await expect(service.submit(trader.address, quote.ticket, sig)).rejects.toThrow('exact 5');
 chain.readContract.mockResolvedValue(0n);
 await expect(service.submit(trader.address, quote.ticket, sig)).rejects.toThrow('5 USDC'); expect(sent).toBe(0);
});
it('uses top-level Flash fills and never presents a pending receipt as confirmed', async () => {
 const { service } = setup();
 expect(await service.status(trader.address, 'order-1')).toMatchObject({ status: 'ACCEPTED', fills: [], unverifiedFills: 0 });
 await expect(service.status(copier.address, 'order-1')).rejects.toThrow('does not belong');
});
it('does not retry uncertain submissions', async () => {
 const { service, fetcher } = setup(); const quote = await service.quote(trader.address, input); const sig = await trader.signTypedData(quote.typedData as never);
 fetcher.mockImplementationOnce(async () => { sent++; throw new Error('network'); });
 await expect(service.submit(trader.address, quote.ticket, sig)).rejects.toMatchObject({ code: 'submission_uncertain' });
 await expect(service.submit(trader.address, quote.ticket, sig)).rejects.toMatchObject({ code: 'submission_uncertain' }); expect(sent).toBe(1);
});
it('requires two confirmations for receipt-backed fills and verifies real transfer amounts', async () => {
 const { service, fetcher } = setup(); const txHash = `0x${'ab'.repeat(32)}`;
 fetcher.mockImplementation(async () => new Response(JSON.stringify({ order: { funderAddress: trader.address, status: 'ORDER_STATUS_FILLED' }, fills: [{ transactionId: txHash }] })));
 const topic = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
 const zero = `0x${'00'.repeat(20)}`;
 const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
 chain.getTransactionReceipt.mockResolvedValue({ transactionHash: txHash, from: zero, status: 'success', blockNumber: 100n, transactionIndex: 0,
  logs: [{ address: TOKENS.USDC.address, topics: [transferTopic, topic(trader.address), topic(vault)], data: '0x4c4b40' },
   { address: TOKENS.WETH.address, topics: [transferTopic, topic(vault), topic(trader.address)], data: `0x${2000000000000000n.toString(16)}` }] });
 expect(await service.status(trader.address, 'order-1')).toMatchObject({ fills: [], unverifiedFills: 1 });
 chain.getBlockNumber.mockResolvedValue(101n);
 const result = await service.status(trader.address, 'order-1');
 expect(result.fills).toHaveLength(1); expect(result.fills[0]).toMatchObject({ usdcMicros: '5000000', assetUnits: '2000000000000000', confirmations: 2 });
 expect(result.unverifiedFills).toBe(0);
});

it.each([{ mode: 'auto', safetyNetBps: 0 }, { mode: 'tap', safetyNetBps: 500 }, {mode:'tap',safetyNetBps:0,liquidateOnBreakup:true}])('refuses a copier pass whose execution promises are unavailable: %j', async terms => {
 const directory = { passes: [{ id: 'seat-1', owner: copier.address.toLowerCase(), traderId: profile.id, status: 'joined', terms: { perTradeUsd: 5, ...terms } }], availability: [], invitations: [] } as unknown as SeatDirectory;
 const { service, fetcher } = setup({}, directory);
 await expect(service.quote(copier.address, { ...input, seatId: 'seat-1', sourceOrderId: 'trader-order' })).rejects.toThrow('protected or automatic');
 expect(fetcher).not.toHaveBeenCalled(); expect(sent).toBe(0);
});

it('accepts the Flash-supplied vault without imposing a client deployment prerequisite', async () => {
 const { service } = setup();
 chain.getCode.mockImplementation(async ({ address }) => address.toLowerCase() === FLASH_DOMAIN.verifyingContract.toLowerCase() ? '0x1234' : undefined);
 const q = await service.quote(trader.address, input);
 expect(q.typedData.message.vault).toBe(vault);
 expect(chain.getCode).toHaveBeenCalledTimes(1);
 expect(chain.getCode).toHaveBeenCalledWith({ address: FLASH_DOMAIN.verifyingContract });
});
it('checks real spending balance and approval gas before any wallet prompt', async () => {
 const { service } = setup(); const q = await service.quote(trader.address, input);
 chain.readContract.mockImplementation(async ({ functionName }) => functionName === 'balanceOf' ? 0n : 5000000n);
 await expect(service.preflight(trader.address, q.ticket)).rejects.toThrow('5 USDC on Base');
 chain.readContract.mockImplementation(async ({ functionName }) => functionName === 'balanceOf' ? 5000000n : 0n);
 chain.getBalance.mockResolvedValue(0n);
 await expect(service.preflight(trader.address, q.ticket)).rejects.toThrow('ETH on Base');
 chain.getBalance.mockResolvedValue(1000000000000000n);
 expect(await service.preflight(trader.address, q.ticket)).toEqual({ ready: true });
 expect(sent).toBe(0);
});

it('allows a default tap seat to reach trader fill verification instead of requiring unimplemented stops',async()=>{
 const directory={passes:[{id:'seat-1',owner:copier.address.toLowerCase(),traderId:profile.id,status:'joined',terms:DEFAULT_TERMS}],availability:[],invitations:[]} as unknown as SeatDirectory;
 const {service,fetcher}=setup({},directory);
 await expect(service.quote(copier.address,{...input,seatId:'seat-1',sourceOrderId:'trader-order'})).rejects.toThrow('matching trader limit buy');
 expect(fetcher).toHaveBeenCalledOnce();
 expect(sent).toBe(0);
});

it('reloads wallet order history from the provider, deduplicates IDs and verifies order ownership',async()=>{
 const {service,fetcher}=setup();
 fetcher.mockImplementation(async(url:string)=>new Response(JSON.stringify(url.includes('/orders?')
  ?{orders:[{orderId:'order-1',funderAddress:trader.address},{orderId:'order-1',funderAddress:trader.address}],nextPageToken:'more'}
  :{order:{orderId:'order-1',funderAddress:trader.address,status:'ACCEPTED'},fills:[]})));
 expect(await service.history(trader.address)).toMatchObject({scope:'latest20Orders',hasMore:true,orders:[{orderId:'order-1',status:'ACCEPTED',fills:[],unverifiedFills:0}]});
 expect(fetcher).toHaveBeenCalledTimes(2);
 fetcher.mockResolvedValueOnce(new Response(JSON.stringify({orders:[{orderId:'order-1',funderAddress:copier.address}]})));
 await expect(service.history(trader.address)).rejects.toThrow('another wallet');
});
it('returns a genuine empty history and keeps provider failures distinct',async()=>{
 const {service,fetcher}=setup();fetcher.mockResolvedValueOnce(new Response(JSON.stringify({orders:[]})));
 expect(await service.history(trader.address)).toMatchObject({orders:[],hasMore:false});
 fetcher.mockResolvedValueOnce(new Response(JSON.stringify({unexpected:true})));
 await expect(service.history(trader.address)).rejects.toThrow('history');
});

it('follows opaque history cursors and rejects repeated pages instead of guessing a cost basis',async()=>{
 const {service,fetcher}=setup();
 fetcher.mockImplementation(async(url:string)=>new Response(JSON.stringify(url.includes('/orders?')
  ?{orders:[],nextPageToken:url.includes('pageToken=')?undefined:'opaque +/='}
  :{order:{funderAddress:trader.address},fills:[]})));
 expect(await service.completeHistory(trader.address)).toEqual([]);
 expect(fetcher.mock.calls[1][0]).toContain('pageToken=opaque%20%2B%2F%3D');
 fetcher.mockImplementation(async()=>new Response(JSON.stringify({orders:[],nextPageToken:'same'})));
 await expect(service.completeHistory(trader.address)).rejects.toThrow('pagination');
});
