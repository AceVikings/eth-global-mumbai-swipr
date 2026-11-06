import { beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';

const clients = vi.hoisted(() => ({ reader: {
  getChainId: vi.fn(), getBalance: vi.fn(), query: vi.fn(), getTransactionReceipt: vi.fn(), getTransactionCount: vi.fn(), getEntity: vi.fn(),
}, writer: { sendRawTransaction: vi.fn(), waitForTransactionReceipt: vi.fn(), signTransaction: vi.fn(), createEntity: vi.fn() } }));
vi.mock('@arkiv-network/sdk', async original => ({ ...await original<typeof import('@arkiv-network/sdk')>(),
  createPublicClient: () => clients.reader, createWalletClient: () => clients.writer }));
vi.mock('viem/actions', async original => ({ ...await original<typeof import('viem/actions')>(), getGasPrice: async () => 1n }));
import { createGasFunder } from './gas-funding';
const key = `0x${'11'.repeat(32)}`;
const wallet = `0x${'22'.repeat(20)}`;
const subject = 'did:privy:test';
const raw = '0x01';
const attrs = () => ({ recipient: { value: wallet }, subject: { value: createHash('sha256').update(subject).digest('hex') }, raw: { value: raw }, nonce: { value: 1n }, amount: { value: '5000000000000000' } });
beforeEach(() => {
  vi.resetAllMocks();
  clients.reader.getChainId.mockResolvedValue(7794095);
  clients.reader.getBalance.mockResolvedValue(0n);
  clients.reader.query.mockResolvedValue({ entities: [] });
  clients.reader.getTransactionCount.mockResolvedValue(0);
  clients.writer.signTransaction.mockResolvedValue(raw);
  clients.writer.sendRawTransaction.mockResolvedValue('0x01');
  clients.writer.waitForTransactionReceipt.mockResolvedValue({ status: 'success' });
  clients.reader.getTransactionReceipt.mockResolvedValue(null);
  clients.reader.getEntity.mockResolvedValue({ $owner: privateKeyToAccount(key as `0x${string}`).address, $attributes: attrs() });
});
it('replays the persisted exact transfer after a crash, without reserving or signing a second grant', async () => {
  clients.writer.createEntity.mockRejectedValueOnce(new Error('response lost after reservation'));
  const funder = createGasFunder({ key, startNonce: 0 });
  await expect(funder.execute({ wallet, subject })).rejects.toThrow('response lost');
  expect(clients.writer.sendRawTransaction).not.toHaveBeenCalled();
  clients.reader.query.mockResolvedValue({ entities: [{ $attributes: attrs() }] });
  await expect(funder.execute({ wallet, subject })).resolves.toMatchObject({ funded: true, replay: true });
  expect(clients.writer.createEntity).toHaveBeenCalledTimes(1);
  expect(clients.writer.signTransaction).toHaveBeenCalledTimes(1);
  expect(clients.writer.sendRawTransaction).toHaveBeenCalledExactlyOnceWith({ serializedTransaction: raw });
});
it('halts on an unexplained signer nonce instead of issuing another payment', async () => {
  clients.reader.getTransactionCount.mockResolvedValue(7);
  await expect(createGasFunder({ key, startNonce: 0 }).execute({ wallet, subject })).rejects.toMatchObject({ code: 'gas_reconciliation_required' });
  expect(clients.writer.signTransaction).not.toHaveBeenCalled();
});
it('does not let one account claim its daily grant through another linked wallet', async () => {
  clients.reader.query.mockResolvedValue({ entities: [{ $attributes: { ...attrs(), recipient: { value: `0x${'33'.repeat(20)}` } } }] });
  await expect(createGasFunder({ key, startNonce: 0 }).execute({ wallet, subject })).rejects.toMatchObject({ code: 'gas_daily_limit' });
  expect(clients.writer.sendRawTransaction).not.toHaveBeenCalled();
});
