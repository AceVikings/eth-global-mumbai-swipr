import { it, expect, vi, beforeEach } from 'vitest';
import type { Session } from '../auth/Session';
import { DEFAULT_TERMS } from '../contracts/types';
import { joinSeat, inviteFriend, leaveSeat } from './wallet-seats';
import { accountRequest, arkivConnection, fundArkivWrite } from './arkiv';
vi.mock('./arkiv', () => ({ accountRequest: vi.fn(), arkivConnection: vi.fn(), fundArkivWrite: vi.fn() }));
const owner = `0x${'12'.repeat(20)}` as const, trader = `0x${'34'.repeat(20)}` as const;
const id = `0x${'ab'.repeat(32)}` as const, traderId = `0x${'cd'.repeat(32)}` as const;
const session = { address: owner } as Session;
const pool = { traderId, traderOwner: trader, traderName: 'Test trader', publicSeats: 1, privateSeats: 1, publicUsed: 0, privateUsed: 0, invited: false, active: true };
const directory = () => ({ passes: [], invitations: [], availability: [pool] });
const createEntity = vi.fn(), receipt = vi.fn(), getEntity = vi.fn();
beforeEach(() => { vi.resetAllMocks(); vi.mocked(accountRequest).mockResolvedValue(directory());
  vi.mocked(arkivConnection).mockResolvedValue({ address: owner, client: { createEntity, waitForTransactionReceipt: receipt }, reader: { getEntity } } as never);
  createEntity.mockResolvedValue({ entityKey: id, txHash: '0x1' }); getEntity.mockResolvedValue({ $owner: owner });
});
it('joins a public seat directly as an immutable copier-owned record without trader approval', async () => {
  const pass = { id, traderId, traderOwner: trader, seatType: 'public', owner, terms: DEFAULT_TERMS, status: 'joined', joinedAt: 1, expiresAt: 2, seatNumber: 1 };
  vi.mocked(accountRequest).mockResolvedValueOnce(directory()).mockResolvedValue({ ...directory(), passes: [pass] });
  expect((await joinSeat(session, traderId, DEFAULT_TERMS, 'public')).status).toBe('joined');
  expect(createEntity.mock.calls[0][2]).toMatchObject({ flags: { readonly: true } });
  expect(fundArkivWrite).toHaveBeenCalledWith(session, owner);
});
it('blocks full and uninvited seats before funding or asking the wallet to write', async () => {
  await expect(joinSeat(session, traderId, DEFAULT_TERMS, 'private')).rejects.toThrow('invitation');
  vi.mocked(accountRequest).mockResolvedValue({ ...directory(), availability: [{ ...pool, publicUsed: 1 }] });
  await expect(joinSeat(session, traderId, DEFAULT_TERMS, 'public')).rejects.toThrow('full');
  expect(fundArkivWrite).not.toHaveBeenCalled(); expect(createEntity).not.toHaveBeenCalled();
});
it('does not report a rejected wallet write as a successful join', async () => {
  createEntity.mockRejectedValue(new Error('Declined'));
  await expect(joinSeat(session, traderId, DEFAULT_TERMS, 'public')).rejects.toThrow('Declined');
  expect(receipt).not.toHaveBeenCalled();
});
it('only allows trader-owned invitations and copier-owned departures', async () => {
  await expect(inviteFriend(session, traderId, owner)).rejects.toThrow('Only the trader');
  vi.mocked(accountRequest).mockResolvedValue({ ...directory(), passes: [{ id, traderId, traderOwner: trader, seatType: 'public', owner: trader, terms: DEFAULT_TERMS }] });
  await expect(leaveSeat(session, id)).rejects.toThrow();
  expect(createEntity).not.toHaveBeenCalled();
});
