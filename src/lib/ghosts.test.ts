import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Ghost, Trader } from '../../shared/types';
import Ghosts from '../components/Ghosts';
import {
  GHOST_DURATION_MS, GHOSTS_KEY, isGhostExpired, loadGhosts, removeGhost, saveGhosts, startGhost,
} from './ghosts';

class MemoryStorage implements Storage {
  private items = new Map<string, string>();
  get length() { return this.items.size; }
  clear() { this.items.clear(); }
  getItem(key: string) { return this.items.get(key) ?? null; }
  key(index: number) { return [...this.items.keys()][index] ?? null; }
  removeItem(key: string) { this.items.delete(key); }
  setItem(key: string, value: string) { this.items.set(key, value); }
}

const blocked = (): Storage => {
  const fail = () => { throw new DOMException('blocked', 'SecurityError'); };
  return { length: 0, clear: fail, getItem: fail, key: fail, removeItem: fail, setItem: fail };
};

const T0 = Date.UTC(2026, 10, 6, 14, 2);
const DAY = 24 * 60 * 60 * 1000;

describe('startGhost', () => {
  it('starts a seven-day ghost without a live signal', () => {
    expect(startGhost([], 'alice', 10, T0)).toEqual([
      { traderId: 'alice', startedAt: T0, perTradeUsd: 10, expiresAt: T0 + 7 * DAY, includedSignalId: null },
    ]);
    expect(GHOST_DURATION_MS).toBe(7 * DAY);
  });

  it('accepts amounts from $5 to $50 only', () => {
    expect(startGhost([], 'a', 5, T0)[0].perTradeUsd).toBe(5);
    expect(startGhost([], 'a', 50, T0)[0].perTradeUsd).toBe(50);
    for (const bad of [4.99, 50.01, 0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => startGhost([], 'a', bad, T0)).toThrow(RangeError);
    }
  });

  it('rejects an empty trader id', () => {
    expect(() => startGhost([], ' ', 10, T0)).toThrow(TypeError);
  });

  it('is idempotent: an existing trader keeps original start, size and expiry', () => {
    const first = startGhost([], 'alice', 10, T0);
    const again = startGhost(first, 'alice', 25, T0 + DAY);
    expect(again).toBe(first);
    expect(again[0]).toEqual(first[0]);
  });

  it('does not restart an expired ghost; it stays as history', () => {
    const first = startGhost([], 'alice', 10, T0);
    const later = T0 + 8 * DAY;
    expect(isGhostExpired(first[0], later)).toBe(true);
    expect(startGhost(first, 'alice', 20, later)).toBe(first);
  });

  it('restarts only after explicit removal', () => {
    const first = startGhost([], 'alice', 10, T0);
    const removed = removeGhost(first, 'alice');
    expect(removed).toEqual([]);
    const restarted = startGhost(removed, 'alice', 20, T0 + 8 * DAY);
    expect(restarted[0]).toMatchObject({ startedAt: T0 + 8 * DAY, perTradeUsd: 20 });
  });

  it('does not mutate its input', () => {
    const list = startGhost([], 'alice', 10, T0);
    const copy = structuredClone(list);
    startGhost(list, 'dan', 10, T0);
    removeGhost(list, 'alice');
    expect(list).toEqual(copy);
  });
});

describe('isGhostExpired', () => {
  it('expires at expiresAt', () => {
    const [g] = startGhost([], 'a', 10, T0);
    expect(isGhostExpired(g, g.expiresAt - 1)).toBe(false);
    expect(isGhostExpired(g, g.expiresAt)).toBe(true);
  });
});

describe('removeGhost', () => {
  it('removes only that trader and returns the same list when absent', () => {
    const list = startGhost(startGhost([], 'alice', 10, T0), 'dan', 15, T0);
    expect(removeGhost(list, 'alice').map((g) => g.traderId)).toEqual(['dan']);
    expect(removeGhost(list, 'nobody')).toBe(list);
  });
});

describe('persistence', () => {
  it('round-trips under swipr.ghosts.v1, including expired history', () => {
    const storage = new MemoryStorage();
    const list = startGhost(startGhost([], 'alice', 10, T0), 'dan', 50, T0 + 1000);
    expect(GHOSTS_KEY).toBe('swipr.ghosts.v1');
    expect(saveGhosts(list, storage)).toBe(true);
    expect(JSON.parse(storage.getItem('swipr.ghosts.v1')!)).toEqual(list);
    expect(loadGhosts(storage, T0 + 30 * DAY)).toEqual(list);
  });

  it('returns [] for missing, corrupt or wrongly shaped data', () => {
    const storage = new MemoryStorage();
    expect(loadGhosts(storage, T0)).toEqual([]);
    for (const raw of ['{not json', 'null', '42', '"x"', '{"traderId":"a"}']) {
      storage.setItem(GHOSTS_KEY, raw);
      expect(loadGhosts(storage, T0)).toEqual([]);
    }
  });

  it('drops invalid records and keeps valid ones', () => {
    const storage = new MemoryStorage();
    const good: Ghost = { traderId: 'alice', startedAt: T0, perTradeUsd: 10, expiresAt: T0 + 7 * DAY, includedSignalId: 'sig-1' };
    const bad = [
      null, 'alice', [],
      { ...good, traderId: '' },
      { ...good, traderId: 7 },
      { ...good, perTradeUsd: 4 },
      { ...good, perTradeUsd: 51 },
      { ...good, perTradeUsd: '10' },
      { ...good, startedAt: 'yesterday' },
      { ...good, startedAt: -1e20, expiresAt: -1e20 + 100000 },
      { ...good, startedAt: -1000 },
      { ...good, expiresAt: 9e15 },
      { ...good, expiresAt: T0 },
      { ...good, expiresAt: T0 + 30 * DAY },
      { ...good, includedSignalId: 3 },
      { ...good, includedSignalId: undefined },
      { ...good, startedAt: T0 + DAY },
    ];
    storage.setItem(GHOSTS_KEY, JSON.stringify([...bad, good]));
    expect(loadGhosts(storage, T0 + 1000)).toEqual([good]);
  });

  it('keeps only the earliest record when a trader is duplicated', () => {
    const storage = new MemoryStorage();
    const early = startGhost([], 'alice', 10, T0)[0];
    const late = startGhost([], 'alice', 30, T0 + DAY)[0];
    storage.setItem(GHOSTS_KEY, JSON.stringify([late, early]));
    expect(loadGhosts(storage, T0 + 2 * DAY)).toEqual([early]);
  });

  it('does not crash when storage is blocked or unavailable', () => {
    expect(loadGhosts(blocked(), T0)).toEqual([]);
    expect(saveGhosts(startGhost([], 'a', 10, T0), blocked())).toBe(false);
    const full = new MemoryStorage();
    full.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); };
    expect(saveGhosts([], full)).toBe(false);
  });

  it('falls back safely when no storage argument is given and none exists', () => {
    expect(typeof globalThis.localStorage === 'undefined' || Array.isArray(loadGhosts())).toBe(true);
    expect(Array.isArray(loadGhosts(undefined, T0))).toBe(true);
    expect(typeof saveGhosts([])).toBe('boolean');
  });
});

describe('Ghosts component', () => {
  const alice: Trader = {
    id: 'alice', name: 'Alice', ens: 'alice.swipr.eth', bio: '', style: 'Balanced',
    avatar: '/assets/alice.jpg', kind: 'human',
  };
  const render = (ghosts: Ghost[], traders: Trader[] = [alice]) =>
    renderToStaticMarkup(createElement(Ghosts, { ghosts, traders, onReal: () => {}, onRemove: () => {} }));

  it('shows clear instructions when empty', () => {
    const html = render([]);
    expect(html).toContain('Discover');
    expect(html).toMatch(/no funds move/i);
  });

  it('shows size, original start and expiry without a fabricated result', () => {
    const html = render(startGhost([], 'alice', 10, T0));
    expect(html).toContain('Alice');
    expect(html).toContain('/assets/alice.jpg');
    expect(html).toContain('$10 / trade');
    expect(html).toMatch(/Started/);
    expect(html).toMatch(/Expire/);
    expect(html).toMatch(/Preview profile/);
    expect(html).toMatch(/Simulation/);
    expect(html).not.toMatch(/\$0(\.00)?(?!\d)/);
    expect(html).not.toMatch(/[+−-]\$\d/);
  });

  it('labels expired ghosts as history and handles unknown traders', () => {
    const list = startGhost([], 'ghost-of-nobody', 10, T0 - 8 * DAY);
    const html = render(list, []);
    expect(html).toMatch(/Expired/);
    expect(html).toMatch(/Unknown trader/);
  });
});
