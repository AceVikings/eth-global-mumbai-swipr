import type { Ghost } from '../../shared/types';

// Local, free simulations started by a right swipe. Only parameters are
// stored; results are derived later from recorded trades, never invented here.
export const GHOSTS_KEY = 'swipr.ghosts.v1';
export const GHOST_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
export const MIN_PER_TRADE_USD = 5;
export const MAX_PER_TRADE_USD = 50;
// Tolerates small clock drift; a record starting further in the future is corrupt.
const FUTURE_SKEW_MS = 5 * 60 * 1000;

const defaultStorage = (): Storage | undefined => {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
};

const isAmount = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n >= MIN_PER_TRADE_USD && n <= MAX_PER_TRADE_USD;

const isGhost = (value: unknown, now: number): value is Ghost => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const g = value as Record<string, unknown>;
  return typeof g.traderId === 'string' && g.traderId.trim() !== ''
    && isAmount(g.perTradeUsd)
    && typeof g.startedAt === 'number' && Number.isFinite(g.startedAt)
    && g.startedAt <= now + FUTURE_SKEW_MS
    && typeof g.expiresAt === 'number' && Number.isFinite(g.expiresAt)
    && g.expiresAt > g.startedAt && g.expiresAt - g.startedAt <= GHOST_DURATION_MS
    && (g.includedSignalId === null || typeof g.includedSignalId === 'string');
};

export const isGhostExpired = (ghost: Ghost, now: number = Date.now()): boolean =>
  now >= ghost.expiresAt;

export function loadGhosts(storage: Storage | undefined = defaultStorage(), now: number = Date.now()): Ghost[] {
  if (!storage) return [];
  let parsed: unknown;
  try {
    const raw = storage.getItem(GHOSTS_KEY);
    if (raw === null) return [];
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  // One ghost per trader; on duplicates the earliest start is the original.
  const byTrader = new Map<string, Ghost>();
  for (const item of parsed) {
    if (!isGhost(item, now)) continue;
    const ghost: Ghost = {
      traderId: item.traderId, startedAt: item.startedAt, perTradeUsd: item.perTradeUsd,
      expiresAt: item.expiresAt, includedSignalId: item.includedSignalId,
    };
    const seen = byTrader.get(ghost.traderId);
    if (!seen || ghost.startedAt < seen.startedAt) byTrader.set(ghost.traderId, ghost);
  }
  return [...byTrader.values()];
}

export function saveGhosts(ghosts: Ghost[], storage: Storage | undefined = defaultStorage()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(GHOSTS_KEY, JSON.stringify(ghosts));
    return true;
  } catch {
    return false;
  }
}

// Idempotent per trader: an existing ghost, active or expired, keeps its
// original start, size and expiry. Restarting requires removeGhost first.
export function startGhost(ghosts: Ghost[], traderId: string, perTradeUsd: number, now: number = Date.now()): Ghost[] {
  if (typeof traderId !== 'string' || traderId.trim() === '') throw new TypeError('traderId is required');
  if (!isAmount(perTradeUsd)) {
    throw new RangeError(`Ghost size must be $${MIN_PER_TRADE_USD}–$${MAX_PER_TRADE_USD} per trade`);
  }
  if (ghosts.some((g) => g.traderId === traderId)) return ghosts;
  return [...ghosts, {
    traderId, startedAt: now, perTradeUsd, expiresAt: now + GHOST_DURATION_MS, includedSignalId: null,
  }];
}

export function removeGhost(ghosts: Ghost[], traderId: string): Ghost[] {
  return ghosts.some((g) => g.traderId === traderId) ? ghosts.filter((g) => g.traderId !== traderId) : ghosts;
}
