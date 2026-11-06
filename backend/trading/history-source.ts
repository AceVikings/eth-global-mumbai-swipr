import type { TradingService } from './service';
import type { BotProfile } from '../contracts/bots';
import type { SeatDirectory } from '../contracts/seats';
import { closedPositions, type VerifiedFill } from './performance';
/** Small bounded read cache; no fabricated fallback when a provider or a page is unavailable. */
export function createHistorySource(trades: Pick<TradingService, 'completeHistory'>) {
  const cache = new Map<string, { until: number; value: Promise<VerifiedFill[]> }>();
  return (wallet: string) => {
    const key = wallet.toLowerCase(), prior = cache.get(key);
    if (prior && prior.until > Date.now()) return prior.value;
    if (cache.size > 200) for (const [k,v] of cache) if (v.until <= Date.now()) cache.delete(k);
    const value = trades.completeHistory(key).catch(error => { if (cache.get(key)?.value === value) cache.delete(key); throw error; });
    cache.set(key, { until: Date.now() + 30000, value });
    return value;
  };
}
export function createPerformanceSource(history: ReturnType<typeof createHistorySource>, profiles: () => Promise<BotProfile[]>, seats: (wallet: string, profiles: BotProfile[]) => Promise<SeatDirectory>) {
  return async () => {
    const directory = await profiles(), traders = new Map<string,string>(), copiers = new Set<string>();
    for (const p of directory) if (!traders.has(p.owner.toLowerCase())) traders.set(p.owner.toLowerCase(), p.name);
    if (traders.size > 50) throw new Error('Performance directory exceeds the verification limit.');
    for (const wallet of traders.keys()) {
      const passes = await seats(wallet, directory);
      for (const pass of passes.passes) if (pass.traderOwner.toLowerCase() === wallet) copiers.add(pass.owner.toLowerCase());
    }
    if (new Set([...traders.keys(), ...copiers]).size > 100) throw new Error('Performance directory exceeds the verification limit.');
    const positions = [];
    for (const wallet of new Set([...traders.keys(), ...copiers])) {
      const fills = await history(wallet);
      if (traders.has(wallet)) positions.push(...closedPositions(fills, wallet, 'trader', traders.get(wallet)!));
      if (copiers.has(wallet)) positions.push(...closedPositions(fills, wallet, 'copier', wallet.slice(0,6) + '…' + wallet.slice(-4)));
    }
    return { positions, asOf: new Date().toISOString() };
  };
}
