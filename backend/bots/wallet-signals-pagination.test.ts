import { describe, expect, it, vi } from 'vitest';
const { client } = vi.hoisted(() => ({ client: {
  getChainId: vi.fn(async () => 7794095), getBlockNumber: vi.fn(async () => 100n), query: vi.fn(),
} }));
vi.mock('@arkiv-network/sdk', () => ({ createPublicClient: () => client }));
import { createWalletSignals } from './wallet-signals';
import type { BotProfile } from '../contracts/bots';
const profiles = [{ id: 'test' }] as BotProfile[];
describe('Arkiv signals pagination', () => {
  it('uses the node page limit and stops when the page is empty', async () => {
    client.query.mockReset().mockResolvedValue({ entities: [] });
    expect(await createWalletSignals({})(profiles)).toEqual([]);
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls[0][1]).toMatchObject({ limit: 100, offset: 0 });
  });
  it('reads the second page without asking Arkiv for more than 100 records', async () => {
    const expired = { $expiresAt: 1n };
    client.query.mockReset().mockResolvedValueOnce({ entities: Array(100).fill(expired) })
      .mockResolvedValueOnce({ entities: [expired] });
    expect(await createWalletSignals({})(profiles)).toEqual([]);
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.query.mock.calls.map(call => call[1])).toEqual([
      expect.objectContaining({ limit: 100, offset: 0 }), expect.objectContaining({ limit: 100, offset: 100 }),
    ]);
  });
});
