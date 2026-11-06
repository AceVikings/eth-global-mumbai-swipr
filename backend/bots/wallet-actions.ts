import { randomBytes } from 'node:crypto';
import { encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters, toHex, type Hex } from 'viem';
import { ApiError } from '../auth';
import type { BotProfile } from '../contracts/bots';
import { WALLET_PROFILE_PROJECT, WALLET_PROFILE_SCHEMA, WALLET_SIGNAL_SCHEMA } from '../contracts/wallet-profile';
import { address, profileUpsert, signalPublish } from './validation';

// Arkiv SDK 1.0.1's native execute ABI. Only create/patch are exposed here; no
// allowance, transfer, signing, arbitrary calldata or service wallet is involved.
export const ARKIV_EXECUTE_ABI = parseAbi(['function execute((uint8 operation, bytes operationData)[] ops) external returns (bytes32[] keys)']);
const ATTRS = '(bytes32 name,uint8 typeId,bytes value)[]';
const NATIVE_KEY = /^0x[0-9a-f]{64}$/i;
const VALIDATION_ID = '00000000-0000-4000-8000-000000000001';
type Attribute = { name: Hex; typeId: number; value: Hex };
function attribute(name: string, value: string, json = false): Attribute {
  return { name: toHex(name, { size: 32 }), typeId: json ? 7 : 0x88, value: toHex(value) };
}
function ordered(attributes: Attribute[]) { return attributes.sort((a, b) => a.name.localeCompare(b.name)); }

/** Returns unsigned calldata. The caller's wallet must approve and broadcast it. */
export function buildWalletAction(input: Record<string, unknown>, profiles: BotProfile[]) {
  if (Object.keys(input).some(k => !['wallet', 'action', 'data'].includes(k))) throw new ApiError(400, 'invalid', 'Unsupported transaction fields.');
  const wallet = address(input.wallet, 'wallet') as `0x${string}`;
  if (!input.data || typeof input.data !== 'object' || Array.isArray(input.data)) throw new ApiError(400, 'invalid', 'Action data is required.');
  const data = input.data as Record<string, unknown>;
  const key = data.profileId;
  const profile = profiles.find(p => p.id === key);
  if (key !== undefined && (typeof key !== 'string' || !NATIVE_KEY.test(key))) throw new ApiError(400, 'invalid', 'Use a wallet-owned Arkiv profile key.');
  if (key !== undefined && !profile) throw new ApiError(404, 'not_found', 'Profile not found.');
  let attributes: Attribute[], operation: number;
  if (input.action === 'profile.upsert') {
    if (profile && (profile.owner.toLowerCase() !== wallet || profile.status !== 'active')) throw new ApiError(403, 'forbidden', 'Use the active profile owner wallet.');
    if (!profile && profiles.filter(p => p.owner.toLowerCase() === wallet).length >= 5) throw new ApiError(429, 'limit', 'You can register up to five bots.');
    const { profileId: _, ...normalized } = profileUpsert({ ...data, profileId: VALIDATION_ID });
    attributes = [attribute('profile', JSON.stringify(normalized), true)];
    if (!profile) attributes.push(attribute('arkiv.schema', WALLET_PROFILE_SCHEMA), attribute('project', WALLET_PROFILE_PROJECT), attribute('status', 'active'));
    operation = profile ? 2 : 1;
  } else if (input.action === 'profile.halt') {
    if (Object.keys(data).some(k => k !== 'profileId') || !profile) throw new ApiError(400, 'invalid', 'Profile key required.');
    if (profile.owner.toLowerCase() !== wallet) throw new ApiError(403, 'forbidden', 'Use the profile owner wallet.');
    attributes = [attribute('status', 'halted')]; operation = 2;
  } else if (input.action === 'signal.publish') {
    if (!profile || profile.status !== 'active') throw new ApiError(409, 'halted', 'An active profile is required.');
    if (profile.operator.toLowerCase() !== wallet) throw new ApiError(403, 'forbidden', 'Use the registered operator wallet.');
    const normalized = { ...signalPublish({ ...data, profileId: VALIDATION_ID }), profileId: profile.id };
    if (!profile.assets.includes(normalized.asset)) throw new ApiError(400, 'invalid', 'Asset is not enabled for this bot.');
    attributes = [attribute('arkiv.schema', WALLET_SIGNAL_SCHEMA), attribute('project', WALLET_PROFILE_PROJECT),
      attribute('profileId', profile.id), attribute('signal', JSON.stringify(normalized), true)];
    operation = 1;
  } else throw new ApiError(400, 'invalid', 'Unsupported wallet action.');
  const operationData = operation === 1
    ? encodeAbiParameters(parseAbiParameters(`(uint128 salt,uint64 expiresAt,uint64 minLifetime,uint8 creationFlags,${ATTRS} attributes)`),
      [{ salt: BigInt(`0x${randomBytes(16).toString('hex')}`), expiresAt: 0n, minLifetime: 1296000n, creationFlags: 0, attributes: ordered(attributes) }])
    : encodeAbiParameters(parseAbiParameters(`(bytes32 entityKey,${ATTRS} mutations)`), [{ entityKey: key as Hex, mutations: ordered(attributes) }]);
  return { requiresWalletApproval: true, kind: input.action === 'signal.publish' ? 'proposal' : 'profile',
    transaction: { from: wallet, to: '0x4400000000000000000000000000000000000044' as const,
      chainId: '0x76edaf', value: '0x0', data: encodeFunctionData({ abi: ARKIV_EXECUTE_ABI, functionName: 'execute', args: [[{ operation, operationData }]] }) } };
}
