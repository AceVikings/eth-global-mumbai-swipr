import { describe, expect, it } from 'vitest';
import type { Ghost } from '../../shared/types';
import { GHOSTS_KEY, createGhostStore, startGhost, type GhostLocks } from './ghosts';

class MemoryStorage implements Storage {
  items = new Map<string, string>();
  blocked = false;
  full = false;
  get length() { return this.items.size; }
  clear() { this.items.clear(); }
  getItem(key: string) {
    if (this.blocked) throw new DOMException('blocked', 'SecurityError');
    return this.items.get(key) ?? null;
  }
  key(index: number) { return [...this.items.keys()][index] ?? null; }
  removeItem(key: string) { this.items.delete(key); }
  setItem(key: string, value: string) {
    if (this.blocked) throw new DOMException('blocked', 'SecurityError');
    if (this.full) throw new DOMException('full', 'QuotaExceededError');
    this.items.set(key, value);
  }
}

// Exclusive FIFO lock shared by every "tab" using it, like navigator.locks.
const fifoLocks = (): GhostLocks & { names: string[] } => {
  let tail: Promise<unknown> = Promise.resolve();
  const names: string[] = [];
  return {
    names,
    request(name, callback) {
      names.push(name);
      const run = tail.then(callback);
      tail = run.catch(() => {});
      return run;
    },
  };
};

const T0 = Date.UTC(2026, 10, 6, 14, 2);
const DAY = 24 * 60 * 60 * 1000;
const stored = (storage: MemoryStorage): string[] =>
  (JSON.parse(storage.items.get(GHOSTS_KEY) ?? '[]') as Ghost[]).map((g) => g.traderId).sort();

describe('createGhostStore across tabs', () => {
  it('keeps both ghosts when two tabs that loaded [] each start one', async () => {
    const storage = new MemoryStorage();
    const locks = fifoLocks();
    const a = createGhostStore({ storage, locks });
    const b = createGhostStore({ storage, locks });
    await a.start('alice', 10, T0);
    const result = await b.start('dan', 20, T0 + 1000);
    expect(stored(storage)).toEqual(['alice', 'dan']);
    expect(result.ghosts.map((g) => g.traderId).sort()).toEqual(['alice', 'dan']);
    expect(result.status).toBe('saved');
    expect(locks.names.every((n) => n === 'swipr.ghosts')).toBe(true);
  });

  it('keeps both when the operations are issued concurrently', async () => {
    const storage = new MemoryStorage();
    const locks = fifoLocks();
    const a = createGhostStore({ storage, locks });
    const b = createGhostStore({ storage, locks });
    await Promise.all([a.start('alice', 10, T0), b.start('dan', 10, T0), a.start('priya', 10, T0)]);
    expect(stored(storage)).toEqual(['alice', 'dan', 'priya']);
  });

  it('re-reads storage right before writing when Web Locks are unavailable', async () => {
    const storage = new MemoryStorage();
    const a = createGhostStore({ storage, locks: null });
    const b = createGhostStore({ storage, locks: null });
    await a.start('alice', 10, T0);
    await b.start('dan', 10, T0);
    expect(stored(storage)).toEqual(['alice', 'dan']);
  });

  it('falls back to a direct read/modify/write if the lock request fails', async () => {
    const storage = new MemoryStorage();
    const broken: GhostLocks = { request: () => Promise.reject(new DOMException('no', 'SecurityError')) };
    const result = await createGhostStore({ storage, locks: broken }).start('alice', 10, T0);
    expect(result.status).toBe('saved');
    expect(stored(storage)).toEqual(['alice']);
  });

  it('does not resurrect a ghost another tab deleted', async () => {
    const storage = new MemoryStorage();
    storage.setItem(GHOSTS_KEY, JSON.stringify(startGhost([], 'alice', 10, T0)));
    const locks = fifoLocks();
    const a = createGhostStore({ storage, locks });
    const b = createGhostStore({ storage, locks });
    expect(a.getSnapshot().ghosts.map((g) => g.traderId)).toEqual(['alice']);
    await b.remove('alice');
    await a.start('dan', 10, T0 + DAY);
    expect(stored(storage)).toEqual(['dan']);
    expect(a.getSnapshot().ghosts.map((g) => g.traderId)).toEqual(['dan']);
  });

  it('keeps another tab\'s original ghost instead of restarting it', async () => {
    const storage = new MemoryStorage();
    const locks = fifoLocks();
    const a = createGhostStore({ storage, locks });
    const b = createGhostStore({ storage, locks });
    await a.start('alice', 10, T0);
    const result = await b.start('alice', 40, T0 + DAY);
    expect(result.existed).toBe(true);
    expect(result.ghosts).toEqual(startGhost([], 'alice', 10, T0));
  });

  it('refresh picks up other tabs\' changes and notifies subscribers', async () => {
    const storage = new MemoryStorage();
    const a = createGhostStore({ storage, locks: null });
    const b = createGhostStore({ storage, locks: null });
    const seen: string[][] = [];
    const unsubscribe = b.subscribe((s) => seen.push(s.ghosts.map((g) => g.traderId)));
    await a.start('alice', 10, T0);
    b.refresh();
    expect(seen).toEqual([['alice']]);
    unsubscribe();
    await a.remove('alice');
    b.refresh();
    expect(seen).toHaveLength(1);
    expect(b.getSnapshot().ghosts).toEqual([]);
  });
});

describe('createGhostStore when storage is unavailable', () => {
  it('reports session-only and keeps ghosts in memory when storage is blocked', async () => {
    const storage = new MemoryStorage();
    storage.blocked = true;
    const store = createGhostStore({ storage, locks: fifoLocks() });
    expect(store.getSnapshot().status).toBe('session-only');
    const result = await store.start('alice', 10, T0);
    expect(result).toMatchObject({ status: 'session-only', existed: false });
    expect(result.ghosts.map((g) => g.traderId)).toEqual(['alice']);
    store.refresh();
    expect(store.getSnapshot().ghosts.map((g) => g.traderId)).toEqual(['alice']);
  });

  it('keeps memory when a write fails and persists it once storage recovers', async () => {
    const storage = new MemoryStorage();
    const store = createGhostStore({ storage, locks: null });
    storage.full = true;
    expect((await store.start('alice', 10, T0)).status).toBe('session-only');
    expect(store.getSnapshot().ghosts.map((g) => g.traderId)).toEqual(['alice']);
    storage.full = false;
    const result = await store.start('dan', 10, T0 + 1000);
    expect(result.status).toBe('saved');
    expect(stored(storage)).toEqual(['alice', 'dan']);
  });

  it('keeps a session-only deletion when storage recovers', async () => {
    const storage = new MemoryStorage();
    storage.setItem(GHOSTS_KEY, JSON.stringify(startGhost([], 'alice', 10, T0)));
    const store = createGhostStore({ storage, locks: null });
    storage.full = true;
    await store.remove('alice');
    storage.full = false;
    await store.start('dan', 10, T0);
    expect(stored(storage)).toEqual(['dan']);
  });

  it('works with no storage at all', async () => {
    const store = createGhostStore({ storage: null, locks: null });
    const result = await store.start('alice', 10, T0);
    expect(result.status).toBe('session-only');
    expect(result.ghosts).toHaveLength(1);
  });

  it('validates input before queueing', () => {
    const store = createGhostStore({ storage: new MemoryStorage(), locks: null });
    expect(() => store.start('alice', 51, T0)).toThrow(RangeError);
    expect(() => store.start('', 10, T0)).toThrow(TypeError);
  });
});
