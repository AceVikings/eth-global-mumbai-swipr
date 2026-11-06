import type { CopyAccounting } from './accounting';
import type { VerifiedFill } from './performance';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createPublicClient, http, erc20Abi, recoverTypedDataAddress, recoverMessageAddress, type Address, type Hex } from 'viem';
import { base } from 'viem/chains';
import { ApiError } from '../auth';
import { createFlashClient, SWIPR_INTEGRATOR_FEE_BPS, FLASH_DOMAIN, TOKENS, toUnits, validateApproval, validateTypedData, cancelMessage, type FlashQuote, type OrderIntent } from '../providers/flash';
import { decodeTransferLegs, type Receipt } from '../providers/base';
import type { BotProfile } from '../contracts/bots';
import type { SeatDirectory } from '../contracts/seats';
const same = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
const id = (v: unknown) => { if (typeof v !== 'string' || !/^[a-z0-9-]{1,128}$/i.test(v)) throw new ApiError(400, 'invalid_order', 'Choose a valid order ID.'); return v; };
function fail(text: string): never { throw new ApiError(409, 'trade_blocked', text); }
const spend = (intent: OrderIntent) => ({ token: intent.side === 'sell' ? TOKENS[intent.asset].address : TOKENS.USDC.address, amount: toUnits(intent.qty, intent.side === 'sell' ? TOKENS[intent.asset].decimals : 6) });
const now = () => Math.floor(Date.now() / 1000);
type Context = { profileId: string; seatId?: string; sourceOrderId?: string };
type Ticket = { version: 1; expiresAt: number; intent: OrderIntent; quote: Pick<FlashQuote, 'quoteId' | 'typedDataRaw' | 'integratorFeeBps'>; context: Context; vault: string };
export type TradingService = ReturnType<typeof createTradingService>;
export function createTradingService(options: { apiKey: string; ticketSecret: string; rpcUrl: string;
  allowAuto?: boolean; accounting?: CopyAccounting; profiles: () => Promise<BotProfile[]>; seats: (wallet: string, profiles: BotProfile[]) => Promise<SeatDirectory>; fetcher?: typeof fetch }) {
  const flash = createFlashClient({ apiKey: options.apiKey, fetch: options.fetcher ?? fetch });
  const chain = createPublicClient({ chain: base, transport: http(options.rpcUrl, { timeout: 8000, retryCount: 0 }) });
  // Tickets bind every reviewed field; neither intent nor vault can be replaced on submission.
  const mac = (body: string) => createHmac('sha256', options.ticketSecret).update('swipr.flash.quote.v1\n' + body).digest();
  const encode = (ticket: Ticket) => { const body = Buffer.from(JSON.stringify(ticket)).toString('base64url'); return `${body}.${mac(body).toString('base64url')}`; };
  const decode = (token: unknown, wallet: string): Ticket => {
    if (typeof token !== 'string' || token.length > 20000) throw new ApiError(400, 'invalid_quote', 'Request a fresh quote.');
    const parts = token.split('.'); const supplied = Buffer.from(parts[1] ?? '', 'base64url');
    if (parts.length !== 2 || supplied.length !== 32 || !timingSafeEqual(mac(parts[0]), supplied)) throw new ApiError(400, 'invalid_quote', 'The quote was changed. Request a new one.');
    const t = JSON.parse(Buffer.from(parts[0], 'base64url').toString()) as Ticket;
    if (t.version !== 1 || t.expiresAt <= now() || !same(t.intent.funder, wallet)) fail('This quote expired or belongs to another wallet.');
    validateTypedData(JSON.parse(t.quote.typedDataRaw), t.intent, { now: now(), maxDeadline: t.expiresAt, expectedVault: t.vault });
    return t;
  };
  const network = async () => { if (await chain.getChainId() !== 8453) fail('The trade network is unavailable.'); };
  const verifyFills = async (result: Awaited<ReturnType<typeof flash.getOrder>>, wallet: string) => {
    const head = await chain.getBlockNumber({ cacheTime: 0 });
    const fills = [];
    for (const hash of new Set(result.fills.map(f => f.transactionId).filter((h): h is string => typeof h === 'string' && /^0x[0-9a-f]{64}$/i.test(h)))) {
      try {
        const r = await chain.getTransactionReceipt({ hash: hash as Hex });
        const confirmations = Number(head - r.blockNumber + 1n);
        if (confirmations < 2 || r.status !== 'success') continue;
        const decoded = decodeTransferLegs({ transactionHash: r.transactionHash, status: '0x1', blockNumber: `0x${r.blockNumber.toString(16)}`, from: r.from,
          logs: r.logs.map(l => ({ address: l.address, topics: l.topics as string[], data: l.data })) } as Receipt, wallet);
        if (decoded.ok) {
          const block = await chain.getBlock({ blockNumber: r.blockNumber });
          fills.push({ txHash: hash, asset: decoded.asset, side: decoded.side, usdcMicros: decoded.usdcMicros.toString(), assetUnits: decoded.assetUnits.toString(), price: decoded.price, blockNumber: Number(r.blockNumber), confirmations, timestamp: Number(block.timestamp) * 1000, transactionIndex: r.transactionIndex });
        }
      } catch { /* Pending, unavailable or malformed receipts are never displayed as fills. */ }
    }
    return fills;
  };
  const order = async (orderId: string, wallet: string) => {
    const result = await flash.getOrder(id(orderId), wallet);
    const raw = result.raw as { order?: Record<string, unknown> };
    if (!raw.order || !same(raw.order.funderAddress, wallet)) fail('This order does not belong to your wallet.');
    if (raw.order.recipientAddress && !same(raw.order.recipientAddress, wallet)) fail('This order has another recipient.');
    return { result, row: raw.order };
  };
  const context = async (wallet: string, input: Context, asset: unknown, qty: unknown, side: unknown = 'buy') => {
    if (side !== 'buy' && side !== 'sell') fail('Choose buy or sell.');
    if (side === 'sell') {
      if ((asset !== 'WETH' && asset !== 'cbBTC') || typeof qty !== 'string' || toUnits(qty, TOKENS[asset].decimals) <= 0n) fail('Choose a supported asset and a positive sell amount.');
      // Exits remain available after a profile halt, seat revocation or expiry.
      return {};
    }
    const profiles = await options.profiles();
    const profile = profiles.find(p => p.id === input.profileId && p.status === 'active');
    if (!profile || (asset !== 'WETH' && asset !== 'cbBTC') || !profile.assets.includes(asset)) fail('Choose an active trader and an enabled asset.');
    if (typeof qty !== 'string' || toUnits(qty, 6) !== 5000000n) fail('The rehearsal is limited to 5 USDC per order.');
    if (same(profile!.owner, wallet)) {
      if (input.seatId || input.sourceOrderId) fail('Trader orders do not use a copier seat.');
      return { profile: profile! };
    }
    const directory = await options.seats(wallet, profiles);
    const seat = directory.passes.find(p => p.id === input.seatId && p.owner === wallet.toLowerCase() && p.traderId === profile!.id && p.status === 'joined');
    if (!seat || seat.terms.perTradeUsd < 5) fail('Join an available seat before copying this trader.');
    if (seat!.terms.safetyNetBps > 0 || (seat!.terms.mode === 'auto' && !options.allowAuto) || seat!.terms.liquidateOnBreakup) fail('This pass requires protected or automatic execution. Those permissions are not ready; no order was submitted.');
    if (!input.sourceOrderId) fail('Choose a confirmed trader order to copy.');
    const source = await order(input.sourceOrderId!, profile!.owner);
    const token = source.row.targetAsset as { address?: unknown } | undefined;
    const contra = source.row.contraAsset as { address?: unknown } | undefined;
    if (source.row.side !== 'buy' || source.row.orderType !== 'limit' || !same(token?.address, TOKENS[asset as 'WETH' | 'cbBTC'].address)
      || !same(contra?.address, TOKENS.USDC.address) || typeof source.row.limitNotionalPrice !== 'string') fail('Choose a matching trader limit buy.');
    const fills = await verifyFills(source.result, profile!.owner);
    if (!fills.some(f => f.asset === asset && f.side === 'buy')) fail('The trader order has no confirmed matching fill yet.');
    const expiry = Date.parse(String(source.row.expiresAt));
    if (!Number.isFinite(expiry) || expiry <= Date.now()) fail('This trader’s copy window has ended.');
    return { seat: seat!, profile: profile!, sharedPrice: source.row.limitNotionalPrice as string, expiresAt: Math.floor(expiry / 1000) };
  };
  // A request that may have reached Flash is never relayed again by this instance.
  // Flash's signed salt remains the chain-level replay boundary across service restarts.
  const submitted = new Map<string, { expiresAt: number; orderId?: string }>();
  return {
    async quote(wallet: string, input: Record<string, unknown>) {
      await network();
      const ctx: Context = { profileId: String(input.profileId ?? ''), ...(input.seatId ? { seatId: String(input.seatId) } : {}), ...(input.sourceOrderId ? { sourceOrderId: id(input.sourceOrderId) } : {}) };
      const checked = await context(wallet, ctx, input.asset, input.qty, input.side ?? 'buy');
      if (checked.seat && options.accounting && (!await options.accounting.available(checked.seat) || await options.accounting.hasSource(checked.seat.id, ctx.sourceOrderId!))) fail('This pass has no available copy budget for this source.');
      const sharedPrice = checked.sharedPrice ?? String(input.sharedPrice ?? '');
      const expiresAt = Math.min(now() + 300, checked.expiresAt ?? Infinity);
      const intent: OrderIntent = { integratorFeeBps: SWIPR_INTEGRATOR_FEE_BPS, side: input.side === 'sell' ? 'sell' : 'buy', asset: input.asset as 'WETH' | 'cbBTC', qty: String(input.qty), funder: wallet, orderType: 'limit', sharedPrice,
        limitNotionalPrice: sharedPrice, maxPriceImpact: '0.01', expireTime: new Date(expiresAt * 1000).toISOString() };
      const quote = await flash.quote(intent);
      const vault = String(quote.typedData.message.vault);
      // Flash supplies and manages the per-chain integrator vault. Its FAQ explicitly
      // says clients need not set or track it; preserve the returned address in the ticket.
      // https://flash.definitive.fi/docs/faq#what-is-the-vault-address-in-the-evm-flashorder-eip-712-payload-and-do-i-need-to-set-or-track-it
      const settlementCode = await chain.getCode({ address: FLASH_DOMAIN.verifyingContract });
      if (!settlementCode || settlementCode === '0x') fail('Flash’s settlement contract is unavailable on Base. No signature was requested.');
      validateTypedData(quote.typedData, intent, { now: now(), maxDeadline: expiresAt, expectedVault: vault });
      const raw = quote.raw as { evm?: { approveTx?: unknown; permitTypedData?: unknown }; fees?: { estimatedFeeNotional?: string } };
      if (raw.evm?.permitTypedData) fail('This rehearsal requires a direct, bounded token approval.');
      const approval = raw.evm?.approveTx ? validateApproval(raw.evm.approveTx, intent, spend(intent).amount) : null;
      return { ticket: encode({ version: 1, expiresAt, intent, quote: { quoteId: quote.quoteId, typedDataRaw: quote.typedDataRaw, integratorFeeBps: quote.integratorFeeBps }, context: ctx, vault }),
        quoteId: quote.quoteId, integratorFeeBps: quote.integratorFeeBps, intent, typedData: quote.typedData, approval, expiresAt, estimatedFeeNotional: raw.fees?.estimatedFeeNotional ?? null };
    },
    async preflight(wallet: string, token: unknown) {
      const t = decode(token, wallet); await network();
      const checked = await context(wallet, t.context, t.intent.asset, t.intent.qty, t.intent.side);
      const spending = spend(t.intent);
      const [code, balance, allowance] = await Promise.all([chain.getCode({ address: wallet as Address }),
        chain.readContract({ address: spending.token, abi: erc20Abi, functionName: 'balanceOf', args: [wallet as Address] }),
        chain.readContract({ address: spending.token, abi: erc20Abi, functionName: 'allowance', args: [wallet as Address, FLASH_DOMAIN.verifyingContract] })]);
      if (code && code !== '0x') fail('This rehearsal requires a plain EOA wallet.');
      if (checked.seat?.terms.mode === 'auto' && allowance < spending.amount) fail('Enable the bounded USDC approval for this pass first.');
      if (balance < spending.amount) fail(t.intent.side === 'buy' ? 'Add at least 5 USDC on Base to your wallet before trading. No signature was requested.' : 'Your wallet does not hold enough of this asset.');
      const boundedAuto = checked.seat?.terms.mode === 'auto' && options.allowAuto && allowance >= spending.amount && allowance <= BigInt(checked.seat.terms.perTradeUsd * checked.seat.terms.tradeCount) * 1000000n;
      if (!boundedAuto && allowance !== spending.amount && await chain.getBalance({ address: wallet as Address }) === 0n)
        fail('Add ETH on Base for the token approval gas. No signature was requested.');
      return { ready: true };
    },
    async approval(wallet: string, token: unknown, hash: unknown) {
      const ticket = decode(token, wallet); await network();
      if (typeof hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(hash)) fail('Invalid approval transaction.');
      try {
        const [tx, receipt, head] = await Promise.all([chain.getTransaction({ hash: hash as Hex }), chain.getTransactionReceipt({ hash: hash as Hex }), chain.getBlockNumber({ cacheTime: 0 })]);
        if (!same(tx.from, wallet)) fail('Approval belongs to another wallet.');
        validateApproval({ to: tx.to, data: tx.input, value: `0x${tx.value.toString(16)}` }, ticket.intent, spend(ticket.intent).amount);
        return { status: receipt.status !== 'success' ? 'failed' : head - receipt.blockNumber >= 1n ? 'confirmed' : 'pending' };
      } catch (e) { if (e instanceof ApiError) throw e; return { status: 'pending' }; }
    },
    async submit(wallet: string, token: unknown, signature: unknown) {
      const t = decode(token, wallet); await network();
      const checked = await context(wallet, t.context, t.intent.asset, t.intent.qty, t.intent.side);
      if (typeof signature !== 'string' || !/^0x[0-9a-f]{130}$/i.test(signature)) fail('A wallet order signature is required.');
      const td = JSON.parse(t.quote.typedDataRaw);
      const signer = await recoverTypedDataAddress({ ...td, signature: signature as Hex });
      if (!same(signer, wallet)) fail('The order signature belongs to another wallet.');
      const spending = spend(t.intent);
      const [code, allowance, balance] = await Promise.all([chain.getCode({ address: wallet as Address }),
        chain.readContract({ address: spending.token, abi: erc20Abi, functionName: 'allowance', args: [wallet as Address, FLASH_DOMAIN.verifyingContract] }),
        chain.readContract({ address: spending.token, abi: erc20Abi, functionName: 'balanceOf', args: [wallet as Address] })]);
      if (code && code !== '0x') fail('This rehearsal requires a plain EOA wallet.');
      const boundedAuto = checked.seat?.terms.mode === 'auto' && options.allowAuto && allowance >= spending.amount && allowance <= BigInt(checked.seat.terms.perTradeUsd * checked.seat.terms.tradeCount) * 1000000n;
      if ((!boundedAuto && allowance !== spending.amount) || balance < spending.amount) fail(t.intent.side === 'buy' ? 'This order needs 5 USDC and an exact 5 USDC approval.' : 'This sell needs sufficient asset balance and an exact token approval.');
      for (const [key, attempt] of submitted) if (attempt.expiresAt < now() - 86400) submitted.delete(key);
      const previous = submitted.get(t.quote.quoteId);
      if (previous?.orderId) return { orderId: previous.orderId };
      if (previous) throw new ApiError(409, 'submission_uncertain', 'This order may already have reached Flash. Check order history before trying anything else.');
      if (submitted.size >= 10000) fail('Trade submissions are temporarily busy.');
      if (checked.seat) {
        if (!options.accounting) fail('Durable copy accounting is unavailable. No order was submitted.');
        const reservation = await options.accounting.reserve(checked.seat, t.context.sourceOrderId!, t.quote.quoteId, spending.amount);
        if (!reservation.created) {
          if (reservation.orderId) return { orderId: reservation.orderId };
          throw new ApiError(409, 'submission_uncertain', 'This source already has a reserved copy. Reconcile its history before continuing.');
        }
      }
      const attempt: { expiresAt: number; orderId?: string } = { expiresAt: t.expiresAt };
      submitted.set(t.quote.quoteId, attempt);
      try {
        const result = await flash.submitOrder({ intent: t.intent, quote: { ...t.quote, typedData: td, raw: {} }, userSignature: signature!,
          policy: { now: now(), maxDeadline: t.expiresAt, expectedVault: t.vault } });
        attempt.orderId = result.orderId;
        if (checked.seat) await options.accounting!.submitted(t.quote.quoteId, result.orderId);
        return result;
      } catch { throw new ApiError(409, 'submission_uncertain', 'Submission could not be confirmed. Check Flash order history; do not submit again.'); }
    },
    async prepareCancel(wallet: string, orderId: string) {
      await network(); await order(orderId, wallet);
      return { orderId, message: cancelMessage(id(orderId)) };
    },
    async cancel(wallet: string, orderId: string, signature: unknown) {
      await network(); await order(orderId, wallet);
      if (typeof signature !== 'string' || !/^0x[0-9a-f]{130}$/i.test(signature)
        || !same(await recoverMessageAddress({ message: cancelMessage(id(orderId)), signature: signature as Hex }), wallet)) fail('Cancellation must be signed by the order wallet.');
      try { await flash.cancelOrder(orderId, signature); return { orderId, cancellationAccepted: true }; }
      catch { throw new ApiError(409, 'submission_uncertain', 'Cancellation could not be confirmed. Check the order status.'); }
    },
    async history(wallet: string) {
      await network();
      const history = await flash.listOrders(wallet);
      const orders = [], seen = new Set<string>();
      for (const row of history.orders.slice(0, 20)) {
        if (!same(row.funderAddress, wallet)) fail('Order history contains another wallet.');
        const orderId = id(row.orderId ?? row.id);
        if (seen.has(orderId)) continue;
        seen.add(orderId);
        const { result } = await order(orderId, wallet);
        const fills = await verifyFills(result, wallet);
        orders.push({ orderId, status: result.status, fills, unverifiedFills: Math.max(0, result.fills.length - fills.length) });
      }
      return { orders, hasMore: history.hasMore, scope: 'latest20Orders' as const };
    },
    /** Complete provider history or an explicit error. Missing pages cannot supply a cost basis. */
    async completeHistory(wallet: string): Promise<VerifiedFill[]> {
      await network();
      const fills: VerifiedFill[] = [], seenOrders = new Set<string>(), seenPages = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < 50; page++) {
        const history = await flash.listOrders(wallet, cursor);
        for (const row of history.orders) {
          if (!same(row.funderAddress, wallet)) fail('Order history contains another wallet.');
          const orderId = id(row.orderId ?? row.id);
          if (seenOrders.has(orderId)) continue; seenOrders.add(orderId);
          const { result } = await order(orderId, wallet);
          const verified = await verifyFills(result, wallet);
          if (verified.length !== result.fills.length) fail('History still has unverified settlements.');
          fills.push(...verified);
        }
        if (!history.hasMore) return fills;
        if (!history.nextPageToken || seenPages.has(history.nextPageToken)) fail('Order history pagination could not be verified.');
        seenPages.add(history.nextPageToken!); cursor = history.nextPageToken;
      }
      return fail('Order history exceeds the verification limit.');
    },
    async status(wallet: string, orderId: string) {
      await network(); const { result } = await order(orderId, wallet); const fills = await verifyFills(result, wallet);
      if (options.accounting && fills.length === result.fills.length) {
        const terminal = ['FILLED','CANCELLED','TERMINATED','REJECTED','EXPIRED'].includes(result.status.replace(/^ORDER_STATUS_/, '').toUpperCase());
        await options.accounting.reconcile(orderId, terminal, fills.reduce((n,f)=>n+(f.side==='buy'?BigInt(f.usdcMicros):0n),0n));
      }
      return { orderId, status: result.status, fills, unverifiedFills: result.fills.length - fills.length };
    },
  };
}
