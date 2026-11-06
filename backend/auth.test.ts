import { describe, it, expect } from 'vitest';
import { generateKeyPair, exportSPKI, SignJWT } from 'jose';
import { createAuthenticator, requireWallet } from './auth';
import { readConfig } from './config';
const wallet = `0x${'a'.repeat(40)}`;
async function fixture() {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const config = readConfig({ PRIVY_APP_ID: 'test-app', PRIVY_APP_SECRET: 'server-secret', PRIVY_VERIFICATION_KEY: await exportSPKI(publicKey) });
  const token = (aud = 'test-app', exp = '1h') => new SignJWT({}).setProtectedHeader({ alg: 'ES256' })
    .setSubject('did:privy:test').setIssuer('privy.io').setAudience(aud).setIssuedAt().setExpirationTime(exp).sign(privateKey);
  const fetcher = async () => Response.json({ id: 'did:privy:test', linked_accounts: [{ type: 'wallet', chain_type: 'ethereum', address: wallet }] });
  return { token, authenticate: createAuthenticator(config, fetcher) };
}
describe('Privy auth boundary', () => {
  it('verifies signed access token and resolves wallet ownership', async () => {
    const { token, authenticate } = await fixture();
    const identity = await authenticate(`Bearer ${await token()}`);
    expect(requireWallet(identity, wallet.toUpperCase().replace('0X', '0x'))).toBe(wallet);
    expect(() => requireWallet(identity, `0x${'b'.repeat(40)}`)).toThrow('linked');
  });
  it('rejects wrong app, expiry, missing and modified signatures', async () => {
    const { token, authenticate } = await fixture();
    for (const value of [undefined, `Bearer ${await token('other')}`, `Bearer ${await token('test-app', '-1h')}`, `Bearer ${(await token()).slice(0, -8)}abcdefgh`]) {
      await expect(authenticate(value)).rejects.toMatchObject({ status: 401 });
    }
  });
  it('fails closed with missing configuration', async () => {
    await expect(createAuthenticator(readConfig({}))()).rejects.toMatchObject({ status: 503 });
  });
});
