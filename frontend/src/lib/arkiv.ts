import { createPublicClient, createWalletClient, ExpirationTime } from '@arkiv-network/sdk';
import { custom, defineChain, type EIP1193Provider, type Hex } from 'viem';
import { WalletProfileSchema, WalletSocialSchema, WALLET_PROFILE_PROJECT } from '../contracts/wallet-profile';
import type { ProfileUpsertData } from '../contracts/bots';
import type { Session } from '../auth/Session';

export const arkivChain = defineChain({ id: 7794095, name: 'Arkiv Rabdi',
  nativeCurrency: { name: 'Golem', symbol: 'tGLM', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.rabdi.db-chain.testnet.arkiv.network'] } }, testnet: true });
const base = ((import.meta.env.VITE_API_URL as string | undefined) || '').replace(/\/$/, '');
async function request(session: Session, path: string, body?: unknown) {
  const token = await session.getAccessToken();
  if (!token) throw new Error('Sign in again to continue.');
  const response = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), cache: 'no-store' });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || 'Account storage is unavailable.');
  return result;
}
async function connection(session: Session) {
  const { address, provider } = await session.getArkivWallet();
  const transport = custom({ async request({ method, params }) {
    if (method === 'eth_sendTransaction' || method.startsWith('eth_sign') || method === 'personal_sign') {
      return provider.request({ method, params } as Parameters<EIP1193Provider['request']>[0]);
    }
    const result = await request(session, '/api/arkiv/rpc', { jsonrpc: '2.0', id: 1, method, params: params ?? [] });
    if (result.error) throw new Error('Arkiv could not process this request.');
    return result.result;
  } });
  return { address, reader: createPublicClient({ chain: arkivChain, transport }), client: createWalletClient({ account: address, chain: arkivChain, transport }) };
}
async function fund(session: Session, wallet: string) {
  // This endpoint checks the confirmed balance and daily limits. Login never invokes it.
  await request(session, '/api/arkiv/gas', { wallet });
}
export async function saveWalletProfile(session: Session, data: ProfileUpsertData) {
  const { client, reader, address } = await connection(session);
  const { profileId, ...profile } = data;
  if (profileId && !/^0x[0-9a-f]{64}$/i.test(profileId)) throw new Error('Create a wallet-owned profile to replace this older registration.');
  if (profileId) {
    const record = await reader.getEntity(profileId as Hex);
    if (record.$owner.toLowerCase() !== address.toLowerCase()) throw new Error('Your wallet does not own this profile.');
  }
  await fund(session, address);
  if (profileId) return client.patchEntity(WalletProfileSchema, profileId as Hex, { set: { profile: JSON.stringify(profile) } });
  return client.createEntity(WalletProfileSchema, { project: WALLET_PROFILE_PROJECT, profile: JSON.stringify(profile), status: 'active' }, { expiration: ExpirationTime.fromDays(30) });
}
export async function haltWalletProfile(session: Session, key: string) {
  const { client, reader, address } = await connection(session);
  if (!/^0x[0-9a-f]{64}$/i.test(key)) throw new Error('This older registration is not wallet-owned.');
  const record = await reader.getEntity(key as Hex);
  if (record.$owner.toLowerCase() !== address.toLowerCase()) throw new Error('Your wallet does not own this profile.');
  await fund(session, address);
  return client.patchEntity(WalletProfileSchema, key as Hex, { set: { status: 'halted' } });
}
export async function writeWalletFollow(session: Session, target: string, follow: boolean) {
  const { client, address } = await connection(session);
  const current = await request(session, `/api/social?wallet=${address}`) as { entityKey: Hex | null; following: string[] };
  const set = new Set(current.following.map(a => a.toLowerCase()));
  const changed = follow ? !set.has(target.toLowerCase()) : set.has(target.toLowerCase());
  if (!changed) return;
  if (follow) set.add(target.toLowerCase()); else set.delete(target.toLowerCase());
  if (set.size > 200) throw new Error('You can follow up to 200 wallets.');
  await fund(session, address);
  const following = JSON.stringify([...set].sort());
  if (current.entityKey) await client.patchEntity(WalletSocialSchema, current.entityKey, { set: { following } });
  else await client.createEntity(WalletSocialSchema, { project: WALLET_PROFILE_PROJECT, following }, { expiration: ExpirationTime.fromDays(30) });
}
export async function deleteWalletAccount(session: Session, progress: (text: string) => void) {
  const { client, reader, address } = await connection(session);
  let manifest = await request(session, `/api/account/data?wallet=${address}`) as {
    entities: { key: Hex }[]; expires: number; deletionMessage: string;
  };
  if (manifest.entities.length) {
    progress('Preparing gas for your data deletion…');
    await fund(session, address);
    progress('Approve deletion of your Swipr records in your wallet…');
    await client.executeBatch({ deletes: manifest.entities.map(e => ({ entityKey: e.key })) });
  }
  // Wait for the read index, then use a fresh, short-lived deletion challenge.
  for (let attempt = 0; attempt < 20; attempt++) {
    manifest = await request(session, `/api/account/data?wallet=${address}`);
    if (!manifest.entities.length) break;
    if (attempt === 19) throw new Error('Your data deletion is confirmed; its index is still updating. Retry account deletion shortly.');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  progress('Confirm account deletion with your wallet signature…');
  const signed = await session.signMessage(manifest.deletionMessage);
  if (signed.address.toLowerCase() !== address.toLowerCase()) throw new Error('Your account changed. Sign in to retry.');
  progress('Removing your Swipr login…');
  await request(session, '/api/account/delete', { wallet: address, expires: manifest.expires, signature: signed.signature });
  for (const key of Object.keys(localStorage)) if (key.startsWith('swipr.')) localStorage.removeItem(key);
  window.dispatchEvent(new StorageEvent('storage', { key: null }));
  await session.logout();
  window.location.reload();
}
