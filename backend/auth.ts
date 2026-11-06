import { importSPKI, jwtVerify } from 'jose';
import type { Config } from './config';
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export type Identity = { userId: string; wallets: string[] };
export function createAuthenticator(config: Config, fetcher: typeof fetch = fetch) {
  const key = config.privyVerificationKey
    ? importSPKI(config.privyVerificationKey.replace(/\\n/g, '\n'), 'ES256') : null;
  // Observe a rejected key promise without logging key material.
  void key?.catch(() => {});
  return async (authorization?: string): Promise<Identity> => {
    if (!key || !config.privyAppId || !config.privySecret) {
      throw new ApiError(503, 'auth_unavailable', 'Privy authentication is not configured.');
    }
    if (!authorization?.startsWith('Bearer ') || authorization.length > 16384) {
      throw new ApiError(401, 'unauthorized', 'Sign in to continue.');
    }
    let userId: string;
    try {
      const { payload } = await jwtVerify(authorization.slice(7), await key, {
        issuer: 'privy.io', audience: config.privyAppId, algorithms: ['ES256'],
        requiredClaims: ['sub', 'exp', 'iat'], maxTokenAge: '1h',
      });
      if (!payload.sub?.startsWith('did:privy:')) throw new Error('Invalid subject');
      userId = payload.sub;
    } catch { throw new ApiError(401, 'unauthorized', 'Your session is invalid or expired.'); }
    // Resolve ownership server-side; never trust a wallet supplied by the browser.
    let response: Response;
    try {
      response = await fetcher(`https://api.privy.io/v1/users/${encodeURIComponent(userId)}`, {
        headers: { authorization: `Basic ${Buffer.from(`${config.privyAppId}:${config.privySecret}`).toString('base64')}`,
          'privy-app-id': config.privyAppId }, signal: AbortSignal.timeout(8000),
      });
    } catch { throw new ApiError(503, 'auth_unavailable', 'Wallet ownership could not be checked.'); }
    if (!response.ok) throw new ApiError(503, 'auth_unavailable', 'Wallet ownership could not be checked.');
    const user = await response.json() as { id?: string; linked_accounts?: { type: string; chain_type?: string; address?: string }[] };
    if (user.id !== userId || !Array.isArray(user.linked_accounts)) throw new ApiError(401, 'unauthorized', 'Invalid user record.');
    const wallets = user.linked_accounts.filter(a => a.type === 'wallet' && a.chain_type === 'ethereum' && /^0x[0-9a-fA-F]{40}$/.test(a.address || ''))
      .map(a => a.address!.toLowerCase());
    return { userId, wallets };
  };
}
export function requireWallet(identity: Identity, wallet: unknown) {
  if (typeof wallet !== 'string' || !identity.wallets.includes(wallet.toLowerCase())) {
    throw new ApiError(403, 'wallet_not_owned', 'Use a wallet linked to your signed-in account.');
  }
  return wallet.toLowerCase();
}
