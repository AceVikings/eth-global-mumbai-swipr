import { createPublicClient } from '@arkiv-network/sdk';
import { rabdi } from '@arkiv-network/sdk/chains';
import { and, eq } from '@arkiv-network/sdk/query';
import { addr, str } from '@arkiv-network/sdk/schema';
import { http, recoverMessageAddress, type Hex } from 'viem';
import { ApiError, type Identity } from './auth';
import type { Config } from './config';

export function deleteAccountMessage(audience: string, userId: string, wallet: string, expires: number) {
  return `Swipr: delete my account\nApp: ${audience}\nUser: ${userId}\nWallet: ${wallet.toLowerCase()}\nExpires: ${expires}`;
}

export function createAccountService(config: Config, fetcher: typeof fetch = fetch) {
  const client = createPublicClient({ chain: rabdi({ accessKey: config.arkiv.accessKey || '' }), transport: http(config.arkiv.rpcUrl) });
  const list = async (wallet: string) => {
    if (await client.getChainId() !== 7794095) throw new ApiError(503, 'wrong_chain', 'Account storage is on the wrong network.');
    const result = await client.query(and(eq('project', str('swipr-mumbai26')), eq('$owner', addr(wallet))), { limit: 101 });
    if (result.entities.length > 100) throw new ApiError(409, 'too_many_records', 'Delete some of your Swipr records before deleting your account.');
    return result.entities.map(e => ({ key: e.$key, schema: String(e.$attributes['arkiv.schema']?.value || 'Swipr data') }));
  };
  return {
    list,
    async health() { return { ok: await client.getChainId() === 7794095 }; },
    async remove(identity: Identity, wallet: string, input: Record<string, unknown>) {
      const expires = input.expires;
      const now = Math.floor(Date.now() / 1000);
      if (typeof expires !== 'number' || !Number.isSafeInteger(expires) || expires <= now || expires > now + 300
        || typeof input.signature !== 'string' || !/^0x[0-9a-f]{130}$/i.test(input.signature)) throw new ApiError(400, 'deletion_confirmation_required', 'Confirm account deletion from your wallet.');
      const recovered = await recoverMessageAddress({ message: deleteAccountMessage(config.botAudience, identity.userId, wallet, expires), signature: input.signature as Hex });
      if (recovered.toLowerCase() !== wallet.toLowerCase()) throw new ApiError(403, 'wrong_wallet', 'Use the wallet that owns your account data.');
      for (const linked of identity.wallets) {
        if ((await list(linked)).length) throw new ApiError(409, 'data_remains', 'Your linked wallets must confirm deletion of their Swipr records first.');
      }
      if (!config.privyAppId || !config.privySecret) throw new ApiError(503, 'auth_unavailable', 'Account deletion is not configured.');
      const response = await fetcher(`https://api.privy.io/v1/users/${encodeURIComponent(identity.userId)}`, {
        method: 'DELETE', headers: { authorization: `Basic ${Buffer.from(`${config.privyAppId}:${config.privySecret}`).toString('base64')}`, 'privy-app-id': config.privyAppId },
        signal: AbortSignal.timeout(10000), redirect: 'error',
      });
      if (!response.ok && response.status !== 404) throw new ApiError(503, 'account_delete_failed', 'Your chain data was deleted, but login deletion could not be confirmed. You can retry.');
      return { deleted: true, wallet, publicHistoryRetained: true };
    },
  };
}
