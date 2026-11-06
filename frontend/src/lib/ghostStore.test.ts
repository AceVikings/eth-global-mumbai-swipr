import { describe, expect, it, vi } from 'vitest';
import { createAccountGhostStore, type GhostIO } from './wallet-ghosts';
import type { WalletGhostRecord } from '../contracts/ghosts';
const first = { traderId: `0x${'ab'.repeat(32)}`, startedAt: 1700000000000, expiresAt: 1700604800000, perTradeUsd: 10, includedSignalId: null };
const row: WalletGhostRecord = { entityKey: `0x${'cd'.repeat(32)}`, ghost: first, status: 'active' };
function fixture() {
  let records: WalletGhostRecord[] = [];
  const io: GhostIO = {
    read: async () => structuredClone(records),
    start: async () => { const existed = records.length > 0; if (!existed) records = [row]; return { records: structuredClone(records), existed }; },
    remove: async () => { records = records.map(r => ({ ...r, status: 'removed' })); return structuredClone(records); },
  };
  return { io };
}
describe('account ghost store', () => {
  it('loads saved records in a fresh browser without browser storage', async () => {
    const { io } = fixture();
    const firstBrowser = createAccountGhostStore(io);
    await firstBrowser.start(first.traderId, 10);
    const anotherBrowser = createAccountGhostStore(io);
    expect(anotherBrowser.getSnapshot().ghosts).toEqual([]);
    await anotherBrowser.refresh();
    expect(anotherBrowser.getSnapshot().ghosts).toEqual([first]);
  });
  it('preserves the original ghost when another browser starts it again', async () => {
    const { io } = fixture();
    await createAccountGhostStore(io).start(first.traderId, 10);
    const second = createAccountGhostStore(io);
    expect((await second.start(first.traderId, 40)).existed).toBe(true);
    expect(second.getSnapshot().ghosts).toEqual([first]);
  });
  it('reflects removals across browsers after a fresh account read', async () => {
    const { io } = fixture();
    const a = createAccountGhostStore(io), b = createAccountGhostStore(io);
    await a.start(first.traderId, 10);
    await b.refresh();
    await a.remove(first.traderId);
    await b.refresh();
    expect(b.getSnapshot().ghosts).toEqual([]);
  });
  it('never creates a local ghost if the wallet write fails', async () => {
    const { io } = fixture();
    io.start = vi.fn().mockRejectedValue(new Error('Wallet rejected'));
    const store = createAccountGhostStore(io);
    await expect(store.start(first.traderId, 10)).rejects.toThrow('Wallet rejected');
    expect(store.getSnapshot()).toMatchObject({ ghosts: [], busy: false });
  });
  it('isolates accounts and surfaces unavailable storage instead of an empty success', async () => {
    const { io } = fixture();
    await createAccountGhostStore(io).start(first.traderId, 10);
    const other = createAccountGhostStore({ ...io, read: async () => [] });
    await other.refresh();
    expect(other.getSnapshot().ghosts).toEqual([]);
    io.read = vi.fn().mockRejectedValue(new Error('Sign in again'));
    const blocked = createAccountGhostStore(io);
    await blocked.refresh();
    expect(blocked.getSnapshot()).toMatchObject({ loading: false, ghosts: [], error: 'Sign in again' });
  });
  it('serializes writes and refreshes so a stale read cannot replace a confirmed change', async () => {
    const { io } = fixture();
    const store = createAccountGhostStore(io);
    await Promise.all([store.start(first.traderId, 10), store.refresh()]);
    expect(store.getSnapshot().ghosts).toEqual([first]);
  });
});
