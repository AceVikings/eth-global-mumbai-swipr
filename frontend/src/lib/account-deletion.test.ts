import { describe, it, expect, vi } from 'vitest';
import { clearWalletRecords } from './account-deletion';

describe('account deletion batches', () => {
  it('deletes all bounded batches and waits for stale index entries to disappear', async () => {
    const first = Array.from({ length: 100 }, (_, i) => ({ key: `key-${i}` }));
    const second = [{ key: 'key-100' }];
    const states = [first, first, second, []];
    const read = vi.fn(async () => ({ entities: states.shift() ?? [], deletionMessage: 'fresh challenge' }));
    const remove = vi.fn(async (_keys: string[]) => {});
    const result = await clearWalletRecords(read, remove, async () => {});
    expect(remove.mock.calls.map(([keys]) => keys.length)).toEqual([100, 1]);
    expect(result.entities).toEqual([]);
    expect(read).toHaveBeenCalledTimes(4);
  });
  it('stops when the wallet rejects deletion', async () => {
    const read = vi.fn(async () => ({ entities: [{ key: 'one' }] }));
    await expect(clearWalletRecords(read, async () => { throw new Error('Declined'); }, async () => {})).rejects.toThrow('Declined');
    expect(read).toHaveBeenCalledOnce();
  });
  it('leaves login deletion blocked when indexing never confirms removal', async () => {
    const read = async () => ({ entities: [{ key: 'one' }] });
    const remove = vi.fn(async () => {});
    await expect(clearWalletRecords(read, remove, async () => {})).rejects.toThrow('index');
    expect(remove).toHaveBeenCalledOnce();
  });
});
