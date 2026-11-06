import type { Ghost } from './types';
export type WalletGhostRecord = { entityKey: `0x${string}`; ghost: Ghost; status: 'active' | 'removed' };
const KEY = /^0x[0-9a-f]{64}$/i;
export function parseWalletGhost(value: unknown): Ghost {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid ghost record.');
  const g = value as Record<string, unknown>;
  const fields = ['traderId', 'startedAt', 'perTradeUsd', 'expiresAt', 'includedSignalId'];
  if (Object.keys(g).some(k => !fields.includes(k)) || typeof g.traderId !== 'string' || !KEY.test(g.traderId)
    || typeof g.perTradeUsd !== 'number' || !Number.isFinite(g.perTradeUsd) || g.perTradeUsd < 5 || g.perTradeUsd > 50
    || typeof g.startedAt !== 'number' || !Number.isSafeInteger(g.startedAt) || g.startedAt < 0
    || typeof g.expiresAt !== 'number' || !Number.isSafeInteger(g.expiresAt) || g.expiresAt > 8_640_000_000_000_000
    || g.expiresAt <= g.startedAt || g.expiresAt - g.startedAt > 7 * 86400000
    || !(g.includedSignalId === null || (typeof g.includedSignalId === 'string' && KEY.test(g.includedSignalId)))) {
    throw new Error('Invalid ghost parameters.');
  }
  return { traderId: g.traderId.toLowerCase(), startedAt: g.startedAt, perTradeUsd: g.perTradeUsd,
    expiresAt: g.expiresAt, includedSignalId: g.includedSignalId as string | null };
}
/** Concurrent starts preserve the original parameters; removed records never enter the view. */
export function activeWalletGhosts(records: WalletGhostRecord[]): Ghost[] {
  const byTrader = new Map<string, Ghost>();
  for (const { ghost, status } of records) {
    if (status !== 'active') continue;
    const previous = byTrader.get(ghost.traderId);
    if (!previous || ghost.startedAt < previous.startedAt) byTrader.set(ghost.traderId, ghost);
  }
  return [...byTrader.values()];
}
