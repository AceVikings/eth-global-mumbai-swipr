import type { Ghost } from '../../shared/types';

// Local, free simulations started by a right swipe. Only parameters are
// stored; results are derived later from recorded trades, never invented here.
export const GHOSTS_KEY = 'swipr.ghosts.v1';
export const GHOST_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
export const MIN_PER_TRADE_USD = 5;
export const MAX_PER_TRADE_USD = 50;
const GHOSTS_LOCK = 'swipr.ghosts';
const MAX_DATE_MS = 8_640_000_000_000_000;

const defaultStorage = (): Storage | undefined => {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
};

const isAmount = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n >= MIN_PER_TRADE_USD && n <= MAX_PER_TRADE_USD;

// Structural only: comparing against the current clock would erase real
// ghosts after the device clock is corrected backwards.
const isTimestamp = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= MAX_DATE_MS;

const isGhost = (value: unknown): value is Ghost => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const g = value as Record<string, unknown>;
  return typeof g.traderId === 'string' && g.traderId.trim() !== ''
    && isAmount(g.perTradeUsd)
    && isTimestamp(g.startedAt) && isTimestamp(g.expiresAt)
    && g.expiresAt > g.startedAt && g.expiresAt - g.startedAt <= GHOST_DURATION_MS
    && (g.includedSignalId === null || typeof g.includedSignalId === 'string');
};

export const isGhostExpired = (ghost: Ghost, now: number = Date.now()): boolean =>
  now >= ghost.expiresAt;

// null means storage could not be read, as opposed to holding no ghosts.
function readGhosts(storage: Storage | null | undefined): Ghost[] | null {
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(GHOSTS_KEY);
  } catch {
    return null;
  }
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  // One ghost per trader; on duplicates the earliest start is the original.
  const byTrader = new Map<string, Ghost>();
  for (const item of parsed) {
    if (!isGhost(item)) continue;
    const ghost: Ghost = {
      traderId: item.traderId, startedAt: item.startedAt, perTradeUsd: item.perTradeUsd,
      expiresAt: item.expiresAt, includedSignalId: item.includedSignalId,
    };
    const seen = byTrader.get(ghost.traderId);
    if (!seen || ghost.startedAt < seen.startedAt) byTrader.set(ghost.traderId, ghost);
  }
  return [...byTrader.values()];
}

export const loadGhosts = (storage: Storage | undefined = defaultStorage()): Ghost[] => readGhosts(storage) ?? [];

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
  if (!isTimestamp(now) || !isTimestamp(now + GHOST_DURATION_MS)) throw new RangeError('Invalid ghost start time');
  if (ghosts.some((g) => g.traderId === traderId)) return ghosts;
  return [...ghosts, {
    traderId, startedAt: now, perTradeUsd, expiresAt: now + GHOST_DURATION_MS, includedSignalId: null,
  }];
}

export function removeGhost(ghosts: Ghost[], traderId: string): Ghost[] {
  return ghosts.some((g) => g.traderId === traderId) ? ghosts.filter((g) => g.traderId !== traderId) : ghosts;
}

export type GhostStorageStatus = 'saved' | 'session-only';
export type GhostSnapshot = { ghosts: Ghost[]; status: GhostStorageStatus };
export type GhostChange = GhostSnapshot & { existed: boolean };
// The subset of navigator.locks used here; requests for one name run exclusively.
export type GhostLocks = { request(name: string, callback: () => unknown): Promise<unknown> };

type GhostOp = { traderId: string } & ({ kind: 'start'; perTradeUsd: number; now: number } | { kind: 'remove' });

const applyOp = (ghosts: Ghost[], op: GhostOp): Ghost[] =>
  op.kind === 'start' ? startGhost(ghosts, op.traderId, op.perTradeUsd, op.now) : removeGhost(ghosts, op.traderId);

const defaultLocks = (): GhostLocks | null => {
  try {
    return globalThis.navigator?.locks ?? null;
  } catch {
    return null;
  }
};

// Every change is an intent (start or remove one trader) replayed over a fresh
// read of storage, so tabs never overwrite each other with stale lists and a
// ghost deleted elsewhere is not written back. Intents that could not be saved
// stay pending and are replayed over the next successful read.
export function createGhostStore({ storage = defaultStorage(), locks = defaultLocks() }: {
  storage?: Storage | null; locks?: GhostLocks | null;
} = {}) {
  const initial = readGhosts(storage);
  let snapshot: GhostSnapshot = { ghosts: initial ?? [], status: initial ? 'saved' : 'session-only' };
  let pending: GhostOp[] = [];
  const listeners = new Set<(snapshot: GhostSnapshot) => void>();

  const publish = (next: GhostSnapshot) => {
    const same = next.status === snapshot.status && JSON.stringify(next.ghosts) === JSON.stringify(snapshot.ghosts);
    snapshot = next;
    if (!same) listeners.forEach((listener) => listener(snapshot));
  };

  const commit = (op: GhostOp): GhostChange => {
    // Read immediately before the synchronous write; unreadable storage keeps memory.
    const fresh = readGhosts(storage);
    const base = pending.reduce(applyOp, fresh ?? snapshot.ghosts);
    const ghosts = applyOp(base, op);
    pending = [...pending, op];
    let saved = false;
    if (fresh) {
      try {
        storage!.setItem(GHOSTS_KEY, JSON.stringify(ghosts));
        saved = true;
        pending = [];
      } catch {
        // Quota or privacy settings: keep the intent for the next attempt.
      }
    }
    publish({ ghosts, status: saved ? 'saved' : 'session-only' });
    return { ...snapshot, existed: ghosts === base && op.kind === 'start' };
  };

  const run = async (op: GhostOp): Promise<GhostChange> => {
    if (!locks) return commit(op);
    let result: GhostChange | undefined;
    try {
      await locks.request(GHOSTS_LOCK, () => { result = commit(op); });
    } catch {
      // Lock manager refused (e.g. opaque origin); commit didn't run.
    }
    return result ?? commit(op);
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: (snapshot: GhostSnapshot) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    start(traderId: string, perTradeUsd: number, now: number = Date.now()) {
      startGhost([], traderId, perTradeUsd, now); // validate before queueing
      return run({ kind: 'start', traderId, perTradeUsd, now });
    },
    remove: (traderId: string) => run({ kind: 'remove', traderId }),
    // Call on `storage` events from other tabs.
    refresh() {
      const fresh = readGhosts(storage);
      if (!fresh) return publish({ ...snapshot, status: 'session-only' });
      publish({ ghosts: pending.reduce(applyOp, fresh), status: pending.length ? 'session-only' : 'saved' });
    },
  };
}

export type GhostStore = ReturnType<typeof createGhostStore>;
