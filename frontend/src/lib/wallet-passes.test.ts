import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Session } from '../auth/Session';
import { DEFAULT_TERMS } from '../contracts/types';
import { passRequestHash } from '../contracts/passes';
import { readWalletPasses, requestWalletPass, respondWalletPass } from './wallet-passes';
import { accountRequest, arkivConnection, fundArkivWrite } from './arkiv';
vi.mock('./arkiv', () => ({ accountRequest: vi.fn(), arkivConnection: vi.fn(), fundArkivWrite: vi.fn() }));
const owner = `0x${'12'.repeat(20)}` as const, traderOwner = `0x${'34'.repeat(20)}`;
const id = `0x${'ab'.repeat(32)}` as const;
const request = { traderId: `0x${'cd'.repeat(32)}`, traderOwner, terms: DEFAULT_TERMS };
const pass = { ...request, id, owner, status: 'pending', requestHash: passRequestHash(request), requestedAt: 1, acceptedAt: null, expiresAt: null };
const session = { address: owner } as Session;
const createEntity = vi.fn(), patchEntity = vi.fn(), receipt = vi.fn(), getEntity = vi.fn();
beforeEach(() => { vi.resetAllMocks(); vi.mocked(accountRequest).mockResolvedValue({ passes: [pass] });
  vi.mocked(arkivConnection).mockResolvedValue({ address: owner, client: { createEntity, patchEntity, waitForTransactionReceipt: receipt }, reader: { getEntity } } as never);
  createEntity.mockResolvedValue({ entityKey: id, txHash: '0x1' }); getEntity.mockResolvedValue({ $owner: owner });
});
describe('wallet pass writes', () => {
  it('rejects another account and tampered acceptance', async () => {
    await expect(readWalletPasses({ address: `0x${'56'.repeat(20)}` } as Session)).rejects.toThrow('Invalid pass');
    vi.mocked(accountRequest).mockResolvedValue({ passes: [{ ...pass, terms: { ...DEFAULT_TERMS, perTradeUsd: 50 } }] });
    await expect(readWalletPasses(session)).rejects.toThrow('Invalid pass');
  });
  it('never accepts a request with the copier wallet', async () => {
    await expect(respondWalletPass(session, id, 'accepted')).rejects.toThrow('cannot change');
    expect(createEntity).not.toHaveBeenCalled(); expect(fundArkivWrite).not.toHaveBeenCalled();
  });
  it('refuses duplicate and self requests', async () => {
    await expect(requestWalletPass(session, { id: request.traderId, owner: traderOwner } as never, DEFAULT_TERMS)).rejects.toThrow('already');
    await expect(requestWalletPass(session, { id: request.traderId, owner } as never, DEFAULT_TERMS)).rejects.toThrow('another');
  });
  it('does not report a cancelled pass when its wallet rejects the transaction', async () => {
    patchEntity.mockRejectedValue(new Error('Declined'));
    await expect(respondWalletPass(session, id, 'cancelled')).rejects.toThrow('Declined');
    expect(receipt).not.toHaveBeenCalled();
  });
});
