import { createHttp, ProviderError, type FetchLike } from './http.ts';
import { BASE_CHAIN_ID, TOKENS, type Asset } from './flash.ts';

export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const HASH = /^0x[0-9a-fA-F]{64}$/;

export interface RpcLog { address: string; topics: string[]; data: string }
export interface Receipt { transactionHash: string; status: string; blockNumber: string; from: string; logs: RpcLog[] }

/** Minimal JSON-RPC reader for Base; reads are idempotent so they are retried. */
export function createBaseRpc(o: { url: string; fetch: FetchLike; timeoutMs?: number }) {
  const http = createHttp({ provider: 'base-rpc', fetch: o.fetch, timeoutMs: o.timeoutMs ?? 6000, secrets: [o.url] });
  let id = 0;
  async function call<T>(method: string, params: unknown[]): Promise<T> {
    const j = await http.json(o.url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    }, { retry: true });
    if (j?.error) throw new ProviderError('base-rpc', 'bad_response', `${method} rpc error ${Number(j.error.code) || ''}`.trim());
    return j.result as T;
  }
  return {
    async chainId() { return Number(await call<string>('eth_chainId', [])); },
    async getReceipt(txHash: string): Promise<Receipt | null> {
      if (!HASH.test(txHash)) throw new ProviderError('base-rpc', 'invalid', 'bad tx hash');
      return call<Receipt | null>('eth_getTransactionReceipt', [txHash]);
    },
    /** Callers must confirm chainId() === 8453 once before trusting receipts. */
    expectedChainId: BASE_CHAIN_ID,
  };
}

export type Decoded =
  | { ok: true; txHash: string; side: 'buy' | 'sell'; asset: Asset; usdcMicros: bigint; assetUnits: bigint; price: string }
  | { ok: false; reason: string };

const topicAddr = (t: string) => '0x' + t.slice(-40).toLowerCase();

/** Fixed-point USDC per whole asset with 6 decimals, truncated. */
function price(usdcMicros: bigint, units: bigint, decimals: number): string {
  const scaled = (usdcMicros * 10n ** BigInt(decimals)) / units; // micros per whole asset
  const s = scaled.toString().padStart(7, '0');
  return `${s.slice(0, -6)}.${s.slice(-6)}`;
}

/**
 * Notary decode v1: exactly one USDC leg and one WETH/cbBTC leg touching `wallet`,
 * in opposite directions. Anything else is rejected with a reason, never guessed.
 */
export function decodeTransferLegs(r: Receipt, wallet: string): Decoded {
  if (r.status !== '0x1') return { ok: false, reason: 'transaction reverted or pending' };
  const me = wallet.toLowerCase();
  const legs: { token: string; dir: 1n | -1n; value: bigint }[] = [];
  for (const l of r.logs ?? []) {
    if (l.topics?.[0]?.toLowerCase() !== TRANSFER_TOPIC || l.topics.length !== 3) continue;
    const from = topicAddr(l.topics[1]), to = topicAddr(l.topics[2]);
    if (from !== me && to !== me) continue;
    if (from === to) continue; // self transfer moves nothing
    let value: bigint;
    try { value = BigInt(l.data); } catch { return { ok: false, reason: 'malformed transfer amount' }; }
    legs.push({ token: l.address.toLowerCase(), dir: to === me ? 1n : -1n, value });
  }
  const assets: Asset[] = ['WETH', 'cbBTC'];
  const usdc = legs.filter((l) => l.token === TOKENS.USDC.address.toLowerCase());
  const other = legs.filter((l) => l.token !== TOKENS.USDC.address.toLowerCase());
  if (usdc.length !== 1) return { ok: false, reason: `expected one USDC leg, found ${usdc.length}` };
  if (other.length !== 1) return { ok: false, reason: `expected one asset leg, found ${other.length}` };
  const asset = assets.find((a) => TOKENS[a].address.toLowerCase() === other[0].token);
  if (!asset) return { ok: false, reason: 'asset leg is not WETH or cbBTC' };
  if (usdc[0].dir === other[0].dir) return { ok: false, reason: 'legs move in the same direction' };
  if (usdc[0].value === 0n || other[0].value === 0n) return { ok: false, reason: 'zero-value leg' };
  return {
    ok: true, txHash: r.transactionHash, side: other[0].dir === 1n ? 'buy' : 'sell', asset,
    usdcMicros: usdc[0].value, assetUnits: other[0].value, price: price(usdc[0].value, other[0].value, TOKENS[asset].decimals),
  };
}
