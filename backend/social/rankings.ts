import type { LeaderboardRow } from '../../shared/social';

/**
 * A closed round trip reconstructed by the server from verified on-chain fills. Trusted INTERNAL
 * input only: never accept these from a client. No ghost, open or proposal positions exist here.
 * All amounts are non-negative integer USD micros (1e-6 USD) as decimal strings.
 */
export type VerifiedClosedPosition = {
  id: string; wallet: string; role: 'trader' | 'copier'; name: string;
  costUsdMicros: string; proceedsUsdMicros: string; feesUsdMicros: string; profitShareUsdMicros: string;
  closedAt: string; entryTx: string; exitTx: string;
};
export type RankOptions = { role: 'trader' | 'copier'; sort: 'percentage' | 'absolute'; following?: string[]; since?: string };

const MICROS = /^(?:0|[1-9]\d{0,24})$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const WALLET = /^0x[0-9a-fA-F]{40}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

type Aggregate = { wallet: string; name: string; latest: number; cost: bigint; net: bigint; count: number };

/** Parses one record; returns null for anything malformed or with non-positive cost. */
function parse(p: VerifiedClosedPosition) {
  if (!p || typeof p !== 'object') return null;
  const { id, wallet, role, name, closedAt, entryTx, exitTx } = p;
  if (typeof id !== 'string' || !id || typeof name !== 'string' || (role !== 'trader' && role !== 'copier')) return null;
  if (typeof wallet !== 'string' || !WALLET.test(wallet) || /^0x0{40}$/.test(wallet)) return null;
  if (typeof entryTx !== 'string' || !HASH.test(entryTx) || typeof exitTx !== 'string' || !HASH.test(exitTx)) return null;
  if (typeof closedAt !== 'string' || !ISO.test(closedAt) || Number.isNaN(Date.parse(closedAt))) return null;
  const amounts = [p.costUsdMicros, p.proceedsUsdMicros, p.feesUsdMicros, p.profitShareUsdMicros];
  if (!amounts.every(a => typeof a === 'string' && MICROS.test(a))) return null;
  const [cost, proceeds, fees, share] = amounts.map(BigInt);
  if (cost <= 0n) return null;
  return { id, wallet: wallet.toLowerCase(), role, name: name.trim(), closedAt: Date.parse(closedAt), cost, net: proceeds - cost - fees - share };
}

/** Signed fixed-point formatting, rounded half away from zero. */
function fixed(numerator: bigint, denominator: bigint, decimals: number): string {
  const negative = numerator < 0n;
  const abs = negative ? -numerator : numerator;
  const scale = 10n ** BigInt(decimals);
  const scaled = (abs * scale * 2n + denominator) / (denominator * 2n);
  const whole = (scaled / scale).toString();
  const frac = (scaled % scale).toString().padStart(decimals, '0');
  return `${negative && scaled !== 0n ? '-' : ''}${whole}${decimals ? `.${frac}` : ''}`;
}

/**
 * Ranks wallets by aggregate net profit (proceeds - cost - fees - profit share) across all included
 * closed positions. Percentage = total net / total cost. Ordering uses exact bigint comparison;
 * ties break by wallet ascending. Duplicate ids count once (first wins).
 */
export function rankClosedPositions(positions: readonly VerifiedClosedPosition[], options: RankOptions): LeaderboardRow[] {
  if (options.role !== 'trader' && options.role !== 'copier') throw new TypeError('role must be trader or copier');
  if (options.sort !== 'percentage' && options.sort !== 'absolute') throw new TypeError('sort must be percentage or absolute');
  const since = options.since === undefined ? -Infinity : Date.parse(options.since);
  if (Number.isNaN(since)) throw new TypeError('since must be an ISO timestamp');
  const follow = options.following && new Set(options.following.map(w => w.toLowerCase()));

  const seen = new Set<string>();
  const byWallet = new Map<string, Aggregate>();
  for (const raw of positions) {
    const p = parse(raw);
    if (!p || seen.has(p.id)) continue;
    seen.add(p.id);
    if (p.role !== options.role || p.closedAt < since || (follow && !follow.has(p.wallet))) continue;
    const agg = byWallet.get(p.wallet) ?? { wallet: p.wallet, name: p.name, latest: -Infinity, cost: 0n, net: 0n, count: 0 };
    if (p.closedAt >= agg.latest) { agg.latest = p.closedAt; agg.name = p.name || agg.name; }
    agg.cost += p.cost; agg.net += p.net; agg.count++;
    byWallet.set(p.wallet, agg);
  }

  const cmp = options.sort === 'absolute'
    ? (a: Aggregate, b: Aggregate) => (b.net > a.net ? 1 : b.net < a.net ? -1 : 0)
    : (a: Aggregate, b: Aggregate) => { const l = b.net * a.cost, r = a.net * b.cost; return l > r ? 1 : l < r ? -1 : 0; };
  return [...byWallet.values()]
    .sort((a, b) => cmp(a, b) || (a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0))
    .map(a => ({
      address: a.wallet, name: a.name || `${a.wallet.slice(0, 6)}…${a.wallet.slice(-4)}`, kind: options.role,
      netProfitUsd: fixed(a.net, 1_000_000n, 2), returnPct: fixed(a.net * 100n, a.cost, 2), closedPositions: a.count,
    }));
}
