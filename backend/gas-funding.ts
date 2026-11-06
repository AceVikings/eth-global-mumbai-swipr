import { createPublicClient, createWalletClient, ExpirationTime, type Expression } from '@arkiv-network/sdk';
import { rabdi } from '@arkiv-network/sdk/chains';
import { and, eq, desc } from '@arkiv-network/sdk/query';
import { defineSchema, str, addr, u64, bytes } from '@arkiv-network/sdk/schema';
import { http, isAddress, keccak256, parseEther, type Hex } from 'viem';
import { getGasPrice } from 'viem/actions';
import { privateKeyToAccount } from 'viem/accounts';
import { createHash } from 'node:crypto';
import { ApiError } from './auth';

const PROJECT = 'swipr-mumbai26';
const SCHEMA = 'swipr.gas-grant.v1';
const Grants = defineSchema(SCHEMA, {
  project: str().indexed(), day: str().indexed(), subject: str().indexed(),
  recipient: addr().indexed(), amount: str(), nonce: u64().indexed(), raw: bytes(),
});
export const FUNDING = { threshold: parseEther('0.001'), target: parseEther('0.005'), daily: parseEther('0.1') };

export function fundingAmount(balance: bigint, reserved: bigint) {
  if (balance >= FUNDING.threshold) return 0n;
  const amount = FUNDING.target - balance;
  if (reserved + amount > FUNDING.daily) throw new ApiError(429, 'gas_budget_exhausted', 'Today’s write-gas budget is used up. Try tomorrow.');
  return amount;
}

/** One serialized funding stream, separate from the product journal signer.
 * Each grant stores its exact signed transfer BEFORE broadcast. Retries can only
 * replay that transaction; a crash cannot create a second transfer for the grant.
 * Unknown wallet nonces fail closed instead of guessing or spending again.
 */
export function createGasFunder(options: { key: string; accessKey?: string; rpcUrl?: string; startNonce: number }) {
  const account = privateKeyToAccount(options.key as Hex);
  const chain = rabdi({ accessKey: options.accessKey || '' });
  const transport = http(options.rpcUrl, { timeout: 10000, retryCount: 0 });
  const reader = createPublicClient({ chain, transport });
  const writer = createWalletClient({ account, chain, transport });
  let queue = Promise.resolve();
  const query = async (day?: string) => {
    const filters: Expression[] = [eq('arkiv.schema', str(SCHEMA)), eq('project', str(PROJECT)), eq('$owner', addr(account.address))];
    if (day) filters.push(eq('day', str(day)));
    return (await reader.query(and(...filters), { limit: day ? 100 : 1, orderBy: desc('nonce', 'u64') })).entities;
  };
  const confirm = async (raw: Hex) => {
    const hash = keccak256(raw);
    const receipt = await reader.getTransactionReceipt({ hash }).catch(() => null);
    if (!receipt) {
      // Broadcasting the same signed bytes cannot pay a different recipient or consume another nonce.
      await writer.sendRawTransaction({ serializedTransaction: raw }).catch(() => {});
    }
    const confirmed = receipt ?? await writer.waitForTransactionReceipt({ hash, timeout: 60000 });
    if (confirmed.status !== 'success') throw new ApiError(503, 'gas_transfer_failed', 'The gas transfer failed. No new transfer will be created for this request.');
    return hash;
  };
  const execute = async (input: unknown) => {
    if (!input || typeof input !== 'object') throw new ApiError(400, 'invalid', 'Invalid gas request.');
    const { wallet, subject } = input as { wallet?: unknown; subject?: unknown };
    if (typeof wallet !== 'string' || !isAddress(wallet) || typeof subject !== 'string' || !/^did:privy:[\w-]{1,120}$/.test(subject)) throw new ApiError(400, 'invalid', 'Invalid gas request.');
    if (await reader.getChainId() !== 7794095) throw new Error('Wrong funding chain');
    const balance = await reader.getBalance({ address: wallet });
    if (balance >= FUNDING.threshold) return { funded: false, chainId: 7794095, token: 'tGLM' };
    const day = new Date().toISOString().slice(0, 10);
    const subjectHash = createHash('sha256').update(subject).digest('hex');
    const grants = await query(day);
    const same = grants.find(e => e.$attributes.recipient?.value.toString().toLowerCase() === wallet.toLowerCase() || e.$attributes.subject?.value === subjectHash);
    if (same) {
      if (same.$attributes.recipient.value.toString().toLowerCase() !== wallet.toLowerCase()) throw new ApiError(429, 'gas_daily_limit', 'Your account already received write gas today.');
      const txHash = await confirm(same.$attributes.raw.value as Hex);
      return { funded: true, txHash, chainId: 7794095, token: 'tGLM', replay: true };
    }
    const reserved = grants.reduce((sum, e) => sum + BigInt(e.$attributes.amount.value.toString()), 0n);
    const amount = fundingAmount(balance, reserved);
    const latest = (await query())[0];
    if (latest) await confirm(latest.$attributes.raw.value as Hex);
    const expected = latest ? Number(latest.$attributes.nonce.value) + 1 : options.startNonce;
    const nonce = await reader.getTransactionCount({ address: account.address, blockTag: 'latest' });
    const pending = await reader.getTransactionCount({ address: account.address, blockTag: 'pending' });
    if (nonce !== expected || pending !== nonce) throw new ApiError(503, 'gas_reconciliation_required', 'Gas funding is waiting for transaction reconciliation.');
    const gasPrice = await getGasPrice(reader);
    if (gasPrice * 21000n > parseEther('0.001')) throw new ApiError(503, 'gas_price_high', 'Write-gas funding is temporarily paused.');
    const raw = await writer.signTransaction({ account, chain, to: wallet, value: amount, nonce: nonce + 1, gas: 21000n, gasPrice, type: 'legacy' });
    const result = await writer.createEntity(Grants, { project: PROJECT, day, subject: subjectHash,
      recipient: addr(wallet), amount: amount.toString(), nonce: u64(BigInt(nonce + 1)), raw: bytes(raw) },
    { expiration: ExpirationTime.fromDays(180) }, { nonce });
    // A replacement or concurrent revision must not cause us to send another grant's transfer.
    const recorded = await reader.getEntity(result.entityKey);
    if (recorded.$owner.toLowerCase() !== account.address.toLowerCase() || recorded.$attributes.raw?.value !== raw) throw new Error('Funding reservation mismatch');
    const txHash = await confirm(raw);
    return { funded: true, txHash, chainId: 7794095, token: 'tGLM', amount: amount.toString() };
  };
  return { execute(input: unknown) {
    const result = queue.then(() => execute(input));
    queue = result.then(() => {}, () => {});
    return result;
  } };
}
