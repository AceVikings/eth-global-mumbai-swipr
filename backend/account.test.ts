import { beforeEach, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
const reader = vi.hoisted(() => ({ getChainId: vi.fn(), query: vi.fn() }));
vi.mock('@arkiv-network/sdk', async original => ({ ...await original<typeof import('@arkiv-network/sdk')>(), createPublicClient: () => reader }));
import { createAccountService, deleteAccountMessage } from './account';
import { readConfig } from './config';
const owner = privateKeyToAccount(`0x${'44'.repeat(32)}`);
const identity = { userId: 'did:privy:test', wallets: [owner.address] };
beforeEach(() => { vi.resetAllMocks(); reader.getChainId.mockResolvedValue(7794095); reader.query.mockResolvedValue({ entities: [] }); });
async function confirmation() {
  const expires = Math.floor(Date.now() / 1000) + 240;
  return { expires, signature: await owner.signMessage({ message: deleteAccountMessage('https://swipr.example', identity.userId, owner.address, expires) }) };
}
it('requires wallet confirmation and removes the login only after native records are gone', async () => {
  const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
  const service = createAccountService(readConfig({ BOT_AUTH_AUDIENCE: 'https://swipr.example', PRIVY_APP_ID: 'test', PRIVY_APP_SECRET: 'fixture' }), fetcher);
  reader.query.mockResolvedValueOnce({ entities: [{ $key: '0x123', $attributes: {} }] });
  await expect(service.remove(identity, owner.address, await confirmation())).rejects.toMatchObject({ code: 'data_remains' });
  expect(fetcher).not.toHaveBeenCalled();
  await expect(service.remove(identity, owner.address, await confirmation())).resolves.toMatchObject({ deleted: true });
  expect(fetcher).toHaveBeenCalledOnce();
});
it('rejects expired confirmation and a signature for a different account', async () => {
  const fetcher = vi.fn();
  const service = createAccountService(readConfig({ BOT_AUTH_AUDIENCE: 'https://swipr.example' }), fetcher);
  const signed = await confirmation();
  await expect(service.remove(identity, owner.address, { ...signed, expires: 1 })).rejects.toMatchObject({ code: 'deletion_confirmation_required' });
  await expect(service.remove({ ...identity, userId: 'did:privy:another' }, owner.address, signed)).rejects.toMatchObject({ code: 'wrong_wallet' });
  expect(fetcher).not.toHaveBeenCalled();
});
