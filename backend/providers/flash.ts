import { decodeFunctionData, erc20Abi } from 'viem';
import { createHttp, ProviderError, type FetchLike } from './http.ts';

// Definitive Flash v1 on Base mainnet. The adapter only relays orders that a wallet
// already signed after review; it never holds keys, signs or decides to trade.
export const BASE_CHAIN_ID = 8453;
export const TOKENS = {
  USDC: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
  WETH: { address: '0x4200000000000000000000000000000000000006', decimals: 18 },
  cbBTC: { address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', decimals: 8 },
} as const;
export type Asset = 'WETH' | 'cbBTC';
export const FLASH_DOMAIN = {
  name: 'DefinitiveFlashAllowance',
  version: '1',
  chainId: BASE_CHAIN_ID,
  verifyingContract: '0x5d00000873b6BF41539e6f5365B0Ff7d3c368f78',
} as const;
export const FLASH_ORDER_FIELDS = ['swapper', 'vault', 'recipient', 'fromToken', 'toToken', 'fromAmount', 'salt', 'deadline'];
export const SWIPR_INTEGRATOR_FEE_BPS = '10'; // 0.1% of each trade, collected by Definitive.
const LEGACY_INTEGRATOR_FEE_BPS = '25';
export const ENTRY_USD = { min: 5, max: 50 };
const API = 'https://flash.definitive.fi/v1';
const PUBLIC_DEV_KEY_PREFIX = 'dpka_513a2bd7';

export interface OrderIntent {
  side: 'buy' | 'sell';
  integratorFeeBps?: string;
  asset: Asset;
  /** buy: USDC notional; sell: asset units. Decimal string. */
  qty: string;
  funder: string;
  orderType: 'limit' | 'market';
  limitNotionalPrice?: string;
  /** Frozen shared price from the trader's signal; entries must equal it exactly. */
  sharedPrice?: string;
  attachedBracket?: { takeProfit?: { notionalPrice: string }; stopLoss?: { notionalPrice: string } };
  maxSlippage?: string;
  maxPriceImpact?: string;
  /** ISO-8601 entry expiry. Quotes default to 15 minutes, never good-til-cancelled. */
  expireTime?: string;
}
// Unix seconds; expectedVault is pinned from the authenticated Flash quote response.
export interface SignPolicy { now: number; maxDeadline: number; expectedVault?: string }
export const FLASH_ORDER_TYPES = FLASH_ORDER_FIELDS.map((name, index) => ({ name, type: index < 5 ? 'address' : 'uint256' }));
export const FLASH_DOMAIN_TYPES = [
  { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' },
];
export interface FlashQuote { integratorFeeBps?: string; quoteId: string; typedDataRaw: string; typedData: TypedData; raw: unknown }
export interface TypedData {
  domain: Record<string, unknown>;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const invalid = (msg: string) => new ProviderError('flash', 'invalid', msg);
const sameAddr = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

/** Exact decimal string → integer base units; rejects excess precision instead of rounding. */
export function toUnits(value: string, decimals: number): bigint {
  if (!DECIMAL.test(value)) throw invalid(`not a decimal amount: ${value.slice(0, 32)}`);
  const [whole, frac = ''] = value.split('.');
  if (frac.length > decimals) throw invalid(`more than ${decimals} decimals`);
  return BigInt(whole + frac.padEnd(decimals, '0'));
}

function fromTo(i: OrderIntent) {
  const asset = TOKENS[i.asset];
  return i.side === 'buy'
    ? { fromToken: TOKENS.USDC.address, toToken: asset.address, fromAmount: toUnits(i.qty, 6) }
    : { fromToken: asset.address, toToken: TOKENS.USDC.address, fromAmount: toUnits(i.qty, asset.decimals) };
}

export function validateIntent(i: OrderIntent): void {
  if (i.integratorFeeBps !== undefined && (!/^(0|[1-9]\d{0,3})$/.test(i.integratorFeeBps) || Number(i.integratorFeeBps) > 1000)) throw invalid('invalid integrator fee');
  if (!ADDRESS.test(i.funder)) throw invalid('funder is not an address');
  if (!(i.asset in TOKENS) || i.asset === ('USDC' as Asset)) throw invalid('unsupported asset');
  if (i.side !== 'buy' && i.side !== 'sell') throw invalid('unsupported side');
  if (i.orderType !== 'limit' && i.orderType !== 'market') throw invalid('unsupported order type');
  const amount = fromTo(i).fromAmount;
  if (amount <= 0n) throw invalid('amount must be positive');
  for (const p of [i.limitNotionalPrice, i.sharedPrice, i.attachedBracket?.takeProfit?.notionalPrice, i.attachedBracket?.stopLoss?.notionalPrice])
    if (p !== undefined && (!DECIMAL.test(p) || Number(p) <= 0)) throw invalid('price must be a positive decimal');
  if (i.side === 'buy') {
    // Same price or no trade: entries are limits at exactly the frozen shared price.
    if (i.orderType !== 'limit' || !i.sharedPrice || i.limitNotionalPrice !== i.sharedPrice)
      throw invalid('entries must be limit orders at the shared price');
    if (amount < BigInt(ENTRY_USD.min * 1e6) || amount > BigInt(ENTRY_USD.max * 1e6)) throw invalid('entry must be $5–50');
  } else if (i.attachedBracket) {
    throw invalid('brackets only protect buys');
  }
  if (i.orderType === 'limit' && !i.limitNotionalPrice) throw invalid('limit needs limitNotionalPrice');
  for (const bound of [i.maxSlippage, i.maxPriceImpact]) {
    if (bound !== undefined && (!DECIMAL.test(bound) || Number(bound) <= 0 || Number(bound) > 0.05)) throw invalid('slippage and price impact must be at most 5%');
  }
  if (i.expireTime !== undefined && (!/^\d{4}-\d\d-\d\dT/.test(i.expireTime) || !Number.isFinite(Date.parse(i.expireTime)))) throw invalid('expiry must be an ISO timestamp');
}

export function parseTypedData(raw: unknown): TypedData {
  let td: any = raw;
  if (typeof raw === 'string') {
    try { td = JSON.parse(raw); } catch { throw invalid('typed data is not JSON'); }
  }
  if (!td || typeof td !== 'object' || !td.domain || !td.types || !td.message || typeof td.primaryType !== 'string')
    throw invalid('typed data is incomplete');
  return td as TypedData;
}

/** Everything a reviewer must hold true before a wallet signs or the API relays a signature. */
export function validateTypedData(td: TypedData, intent: OrderIntent, policy: SignPolicy): void {
  const d = td.domain;
  if (d.name !== FLASH_DOMAIN.name || d.version !== FLASH_DOMAIN.version) throw invalid('unexpected domain');
  if (String(d.chainId) !== String(BASE_CHAIN_ID)) throw invalid('domain is not Base');
  if (!sameAddr(d.verifyingContract, FLASH_DOMAIN.verifyingContract)) throw invalid('unexpected verifyingContract');
  const fields = td.types[td.primaryType]?.map((f) => f.name);
  if (td.primaryType !== 'FlashOrder' || JSON.stringify(fields) !== JSON.stringify(FLASH_ORDER_FIELDS)) throw invalid('unexpected order type fields');
  if (JSON.stringify(td.types.FlashOrder) !== JSON.stringify(FLASH_ORDER_TYPES) || JSON.stringify(td.types.EIP712Domain) !== JSON.stringify(FLASH_DOMAIN_TYPES)) throw invalid('unexpected typed data field types');
  const m = td.message;
  const want = fromTo(intent);
  if (!policy.expectedVault || !ADDRESS.test(policy.expectedVault) || !sameAddr(m.vault, policy.expectedVault)) throw invalid('verified vault required');
  for (const name of ['fromAmount', 'salt', 'deadline']) if (typeof m[name] !== 'string' || !/^\d+$/.test(m[name] as string)) throw invalid('amount, salt and deadline must be decimal strings');
  if (!sameAddr(m.swapper, intent.funder) || !sameAddr(m.recipient, intent.funder)) throw invalid('swapper/recipient must be the funder');
  if (!sameAddr(m.fromToken, want.fromToken) || !sameAddr(m.toToken, want.toToken)) throw invalid('token pair does not match intent');
  let amount: bigint;
  let deadline: number;
  try { amount = BigInt(m.fromAmount as string); deadline = Number(m.deadline); } catch { throw invalid('bad amount'); }
  if (amount !== want.fromAmount) throw invalid('fromAmount does not match intent');
  if (!Number.isSafeInteger(deadline) || deadline <= policy.now || deadline > policy.maxDeadline) throw invalid('deadline outside allowed window');
}

/** Never relay a provider-supplied unlimited approval or an arbitrary transaction. */
export function validateApproval(raw: unknown, intent: OrderIntent, maxAmount: bigint) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('approval transaction required');
  const tx = raw as Record<string, unknown>;
  const want = fromTo(intent);
  if (!sameAddr(tx.to, want.fromToken) || typeof tx.data !== 'string' || !/^0x[0-9a-f]+$/i.test(tx.data)
    || (tx.value !== undefined && tx.value !== '0' && tx.value !== '0x0') || maxAmount < want.fromAmount) throw invalid('unexpected approval transaction');
  try {
    const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data as `0x${string}` });
    if (decoded.functionName !== 'approve') throw invalid('approval function required');
    const [spender, amount] = decoded.args as readonly [string, bigint];
    if (!sameAddr(spender, FLASH_DOMAIN.verifyingContract) || amount < want.fromAmount || amount > maxAmount
      || tx.data.length !== 138) throw invalid('approval exceeds reviewed scope');
    return { to: want.fromToken, data: tx.data, value: '0x0', chainId: BASE_CHAIN_ID, amount: amount.toString(), spender };
  } catch { throw invalid('approval exceeds reviewed scope'); }
}

export const cancelMessage = (orderId: string) => `Definitive Flash v1 — Cancel Order\nOrder: ${orderId}`;
const checkId = (id: string) => { if (!/^[\w-]{1,128}$/.test(id)) throw invalid('bad order id'); return id; };
const checkSig = (s: string) => { if (!/^0x[0-9a-fA-F]{130}$/.test(s)) throw invalid('bad signature'); return s; };

export function createFlashClient(o: { apiKey: string; fetch: FetchLike; timeoutMs?: number; baseUrl?: string; sleep?: (ms: number) => Promise<void> }) {
  if (!o.apiKey.trim() || o.apiKey.startsWith(PUBLIC_DEV_KEY_PREFIX)) throw invalid('private Flash API key required');
  const base = o.baseUrl ?? API;
  const http = createHttp({ provider: 'flash', fetch: o.fetch, timeoutMs: o.timeoutMs ?? 8000, minIntervalMs: 220, secrets: [o.apiKey], sleep: o.sleep });
  const headers = { 'x-definitive-api-key': o.apiKey, 'content-type': 'application/json' };
  const body = (i: OrderIntent, expireTime?: string, fee = i.integratorFeeBps ?? SWIPR_INTEGRATOR_FEE_BPS) => ({
    targetChain: 'base', contraChain: 'base', targetAsset: TOKENS[i.asset].address, contraAsset: TOKENS.USDC.address,
    side: i.side, qty: i.qty, orderType: i.orderType, funderAddress: i.funder, flashIntegratorFeeBps: fee,
    evmUsePermit2: false, forceMinimalAllowance: true,
    ...(expireTime && { expireTime }),
    ...(i.limitNotionalPrice && { limitNotionalPrice: i.limitNotionalPrice }),
    ...(i.attachedBracket && { attachedBracket: i.attachedBracket }),
    ...(i.maxSlippage && { maxSlippage: i.maxSlippage }),
    ...(i.maxPriceImpact && { maxPriceImpact: i.maxPriceImpact }),
  });
  const ok = (j: any, what: string) => { if (!j || j.error) throw new ProviderError('flash', 'bad_response', `${what} returned an error`); return j; };

  return {
    async quote(intent: OrderIntent): Promise<FlashQuote> {
      validateIntent(intent);
      const expiry = intent.expireTime ?? new Date(Date.now() + 900000).toISOString();
      const duration = Date.parse(expiry) - Date.now();
      if (duration <= 0 || duration > 900000) throw invalid('entry expiry must be within 15 minutes');
      const j = ok(await http.json(`${base}/quote`, { method: 'POST', headers, body: JSON.stringify(body(intent, expiry)) }, { retry: true }), 'quote');
      const raw = j.evm?.orderTypedData;
      if (typeof j.quoteId !== 'string' || !raw) throw new ProviderError('flash', 'bad_response', 'quote missing id or typed data');
      return { integratorFeeBps: intent.integratorFeeBps ?? SWIPR_INTEGRATOR_FEE_BPS, quoteId: j.quoteId, typedDataRaw: typeof raw === 'string' ? raw : JSON.stringify(raw), typedData: parseTypedData(raw), raw: j };
    },
    /** Relays a user signature; re-validates first and never retries (an error may be `ambiguous`). */
    async submitOrder(a: { intent: OrderIntent; quote: FlashQuote; userSignature: string; policy: SignPolicy }) {
      validateIntent(a.intent);
      const signedData = parseTypedData(a.quote.typedDataRaw);
      validateTypedData(signedData, a.intent, a.policy);
      const fee = a.quote.integratorFeeBps ?? a.intent.integratorFeeBps ?? LEGACY_INTEGRATOR_FEE_BPS;
      if (a.intent.integratorFeeBps !== undefined && a.intent.integratorFeeBps !== fee) throw invalid('fee changed after quote');
      validateIntent({ ...a.intent, integratorFeeBps: fee });
      if (a.intent.attachedBracket) throw invalid('attached brackets require a separate protective-order signature');
      const j = ok(await http.json(`${base}/order`, { method: 'POST', headers, body: JSON.stringify({
        ...body(a.intent, new Date(Number(signedData.message.deadline) * 1000).toISOString(), fee), userSignature: checkSig(a.userSignature), evmOrderTypedData: a.quote.typedDataRaw, quoteId: a.quote.quoteId,
      }) }), 'order');
      if (typeof j.orderId !== 'string') throw new ProviderError('flash', 'bad_response', 'order id missing', { ambiguous: true });
      return { orderId: j.orderId as string };
    },
    async getOrder(orderId: string, funder: string) {
      if (!ADDRESS.test(funder)) throw invalid('funder is not an address');
      const j = ok(await http.json(`${base}/orders/${checkId(orderId)}?funderAddress=${funder}`, { headers }, { retry: true }), 'order status');
      const o = j.order ?? j;
      return { status: String(o.status ?? 'UNKNOWN'), fills: (j.fills ?? o.fills ?? []) as { transactionId?: string; fillPrice?: string }[], raw: j };
    },
    async cancelOrder(orderId: string, userSignature: string) {
      return ok(await http.json(`${base}/orders/${checkId(orderId)}/cancel`, { method: 'POST', headers, body: JSON.stringify({
        cancelMessage: cancelMessage(orderId), userSignature: checkSig(userSignature),
      }) }), 'cancel');
    },
  };
}
export type FlashClient = ReturnType<typeof createFlashClient>;

export function flashFromEnv(env: Record<string, string | undefined>, fetch: FetchLike) {
  const key = (env.FLASH_KEY_EXEC || env.FLASH_API_KEY)?.trim();
  if (!key) return { ok: false as const, reason: 'FLASH_API_KEY missing' };
  if (key.startsWith(PUBLIC_DEV_KEY_PREFIX)) return { ok: false as const, reason: 'public dev key refused for orders' };
  return { ok: true as const, client: createFlashClient({ apiKey: key, fetch }) };
}
