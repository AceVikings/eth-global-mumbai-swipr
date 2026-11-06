import type { VerifiedClosedPosition } from '../social/rankings';
import type { Ghost } from '../contracts/types';
export type VerifiedFill = {
  txHash: string; asset: string; side: string; usdcMicros: string; assetUnits: string;
  blockNumber: number; timestamp: number; transactionIndex: number;
};
type Lot = { units: bigint; cost: bigint; entryTx: string };
const integer = /^(0|[1-9]\d*)$/;
/** Wallet cash flows already include execution fees. Never subtract those fees a second time. */
export function closedPositions(fills: VerifiedFill[], wallet: string, role: 'trader' | 'copier', name: string): VerifiedClosedPosition[] {
  const lots = new Map<string, Lot[]>(), seen = new Set<string>(), positions: VerifiedClosedPosition[] = [];
  for (const f of ordered(fills)) {
    if (seen.has(f.txHash)) continue; seen.add(f.txHash);
    const queue = lots.get(f.asset) ?? []; lots.set(f.asset, queue);
    let units = BigInt(f.assetUnits), cash = BigInt(f.usdcMicros);
    if (f.side === 'buy') { queue.push({ units, cost: cash, entryTx: f.txHash }); continue; }
    // A sell without known cost basis cannot manufacture profit. Discard that inventory.
    if (queue.reduce((n, l) => n + l.units, 0n) < units) { queue.length = 0; continue; }
    let index = 0;
    while (units > 0n) {
      const lot = queue[0], used = units < lot.units ? units : lot.units;
      const cost = used === lot.units ? lot.cost : lot.cost * used / lot.units;
      const proceeds = used === units ? cash : cash * used / units;
      positions.push({ id: `${wallet.toLowerCase()}:${f.txHash}:${index++}`, wallet, role, name,
        costUsdMicros: cost.toString(), proceedsUsdMicros: proceeds.toString(), feesUsdMicros: '0', profitShareUsdMicros: '0',
        entryTx: lot.entryTx, exitTx: f.txHash, closedAt: new Date(f.timestamp).toISOString() });
      lot.units -= used; lot.cost -= cost; units -= used; cash -= proceeds;
      if (!lot.units) queue.shift();
    }
  }
  return positions;
}
function ordered(fills: VerifiedFill[]) {
  return fills.filter(f => ['WETH', 'cbBTC'].includes(f.asset) && ['buy', 'sell'].includes(f.side)
    && /^0x[0-9a-f]{64}$/i.test(f.txHash) && integer.test(f.assetUnits) && BigInt(f.assetUnits) > 0n
    && integer.test(f.usdcMicros) && BigInt(f.usdcMicros) > 0n && Number.isSafeInteger(f.timestamp) && f.timestamp > 0
    && Number.isSafeInteger(f.blockNumber) && Number.isSafeInteger(f.transactionIndex))
    .sort((a,b) => a.blockNumber - b.blockNumber || a.transactionIndex - b.transactionIndex || a.txHash.localeCompare(b.txHash));
}
export type GhostResult = { traderId: string; buys: number; closedTrades: number; openTrades: number; realizedPnlUsd: string; investedUsd: string; state: 'ready' | 'unavailable' };
const usd = (n: bigint) => `${n < 0n ? '-' : ''}${(n < 0n ? -n : n) / 1000000n}.${((n < 0n ? -n : n) % 1000000n).toString().padStart(6, '0')}`;
/** Fixed-size hypothetical buys at actual trader prices; proportional sells, no mark-to-market guesses. */
export function ghostResult(ghost: Ghost, fills: VerifiedFill[]): GhostResult {
  const inventory = new Map<string, { trader: bigint; simulated: bigint; cost: bigint }>();
  const seen = new Set<string>(); let buys = 0, closedTrades = 0, net = 0n, invested = 0n;
  for (const f of ordered(fills)) {
    if (f.timestamp < ghost.startedAt || f.timestamp >= ghost.expiresAt || seen.has(f.txHash)) continue;
    seen.add(f.txHash);
    const row = inventory.get(f.asset) ?? { trader: 0n, simulated: 0n, cost: 0n };
    inventory.set(f.asset, row);
    const units = BigInt(f.assetUnits), cash = BigInt(f.usdcMicros);
    if (f.side === 'buy') {
      const size = BigInt(Math.round(ghost.perTradeUsd * 1e6));
      row.trader += units; row.simulated += units * size / cash; row.cost += size; buys++; invested += size;
    } else if (row.trader > 0n) {
      const sold = units < row.trader ? units : row.trader;
      const simulated = sold === row.trader ? row.simulated : row.simulated * sold / row.trader;
      const cost = sold === row.trader ? row.cost : row.cost * sold / row.trader;
      net += cash * simulated / units - cost;
      row.trader -= sold; row.simulated -= simulated; row.cost -= cost; closedTrades++;
    }
  }
  return { traderId: ghost.traderId, buys, closedTrades, openTrades: [...inventory.values()].filter(r => r.cost > 0n).length,
    realizedPnlUsd: usd(net), investedUsd: usd(invested), state: 'ready' };
}
