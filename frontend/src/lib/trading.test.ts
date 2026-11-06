import { afterEach, expect, it, vi } from 'vitest';
import type { Session } from '../auth/Session';
import { sendReviewedTrade, tradeRequest, type TradeQuote } from './trading';
const wallet = `0x${'12'.repeat(20)}` as const;
const quote = (): TradeQuote => ({ ticket: 'bound-ticket', quoteId: 'q', expiresAt: Math.floor(Date.now()/1000) + 300, estimatedFeeNotional: '0.02',
 intent: { funder: wallet, qty: '5', asset: 'WETH', sharedPrice: '2500' }, typedData: { domain: {}, types: {}, primaryType: 'FlashOrder', message: {} },
 approval: { to: `0x${'34'.repeat(20)}`, data: '0x095ea7b3', value: '0x0', chainId: 8453 } });
const session = (request: ReturnType<typeof vi.fn>, address: string = wallet) => ({ address: wallet, getAccessToken: async () => 'test-token',
 getBaseWallet: vi.fn(async () => ({ address, provider: { request } })) } as unknown as Session);
afterEach(() => vi.unstubAllGlobals());
it('waits for approval verification before signing and submits exactly once', async () => {
 const request = vi.fn().mockResolvedValueOnce(`0x${'ab'.repeat(32)}`).mockResolvedValueOnce(`0x${'cd'.repeat(65)}`);
 const paths: string[] = [];
 vi.stubGlobal('fetch', vi.fn(async (url: string) => { paths.push(url); return new Response(JSON.stringify(url.endsWith('approval') ? { status: 'confirmed' } : { orderId: 'order-1' })); }));
 const q = quote(); const progress = vi.fn();
 expect(await sendReviewedTrade(session(request), q, progress, new AbortController().signal)).toEqual({ orderId: 'order-1' });
 expect(request.mock.calls.map(c => c[0].method)).toEqual(['eth_sendTransaction', 'eth_signTypedData_v4']);
 expect(JSON.parse(request.mock.calls[1][0].params[1])).toEqual(q.typedData);
 expect(paths.map(p => p.split('/').pop())).toEqual(['preflight', 'approval', 'submit']);
});
it('does not sign or submit after a declined approval', async () => {
 const request = vi.fn().mockRejectedValueOnce(new Error('Declined')); const fetcher = vi.fn(async () => new Response(JSON.stringify({ ready: true }))); vi.stubGlobal('fetch', fetcher);
 await expect(sendReviewedTrade(session(request), quote(), vi.fn(), new AbortController().signal)).rejects.toThrow('Declined');
 expect(request).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledTimes(1);
});
it('rejects expired quotes and different wallets before requesting approvals', async () => {
 vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ready: true }))));
 const request = vi.fn(); const s = session(request);
 await expect(sendReviewedTrade(s, { ...quote(), expiresAt: 1 }, vi.fn(), new AbortController().signal)).rejects.toThrow('expired');
 expect(s.getBaseWallet).not.toHaveBeenCalled();
 await expect(sendReviewedTrade(session(request, `0x${'56'.repeat(20)}`), quote(), vi.fn(), new AbortController().signal)).rejects.toThrow('another wallet');
 expect(request).not.toHaveBeenCalled();
});
it('does not sign after an account change aborts approval polling', async () => {
 const ctrl = new AbortController(); const request = vi.fn(async () => { ctrl.abort(); return '0x1'; }); const fetcher = vi.fn(async () => new Response(JSON.stringify({ ready: true }))); vi.stubGlobal('fetch', fetcher);
 await expect(sendReviewedTrade(session(request), quote(), vi.fn(), ctrl.signal)).rejects.toThrow('stopped');
 expect(request).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledTimes(1);
});
it('marks network and server submit failures uncertain and never retries', async () => {
 const fetcher = vi.fn(async () => { throw new Error('lost'); }); vi.stubGlobal('fetch', fetcher);
 await expect(tradeRequest(session(vi.fn()), 'submit', {})).rejects.toMatchObject({ uncertain: true });
 expect(fetcher).toHaveBeenCalledTimes(1);
});

it('does not open the wallet when preflight reports missing Base funds', async () => {
 const request = vi.fn(); const s = session(request);
 vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Add at least 5 USDC on Base.' } }), { status: 409 })));
 await expect(sendReviewedTrade(s, quote(), vi.fn(), new AbortController().signal)).rejects.toThrow('5 USDC on Base');
 expect(s.getBaseWallet).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
});
