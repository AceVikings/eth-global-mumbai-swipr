import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { PrivyProvider, useLogin, useLogout, usePrivy, useWallets } from '@privy-io/react-auth';
import type { ConnectedWallet, PrivyClientConfig } from '@privy-io/react-auth';
import { getAddress, isAddress, recoverMessageAddress, toHex } from 'viem';
import { base } from 'viem/chains';
import type { EIP1193Provider } from 'viem';
import { arkivChain, deleteWalletAccount } from '../lib/arkiv';
import './session.css';

export type Address = `0x${string}`;
export type SignedMessage = { address: Address; signature: `0x${string}` };
export type Session = {
  /** False when VITE_PRIVY_APP_ID is absent. Nothing can sign in; there is no fake session. */
  configured: boolean;
  ready: boolean;
  authenticated: boolean;
  /** Linked EVM wallet used for signing, or null until one is ready. */
  address: Address | null;
  /** Display label (Account name or email). Shown in UI only; never log it. */
  userLabel: string | null;
  /** Last login/logout/sign error, safe to show to the user. */
  error: string | null;
  login: () => void;
  logout: () => Promise<void>;
  signMessage: (message: string) => Promise<SignedMessage>;
  /** Fresh Privy access token, kept in memory only. Null when signed out. */
  getAccessToken: () => Promise<string | null>;
  getArkivWallet: () => Promise<{ address: Address; provider: EIP1193Provider }>;
};

const appId = (import.meta.env.VITE_PRIVY_APP_ID as string | undefined)?.trim() || '';
const apiBase = ((import.meta.env.VITE_API_URL as string | undefined) || '').replace(/\/$/, '');
const notConfigured = 'Sign-in is not configured for this deployment.';
const SessionContext = createContext<Session | null>(null);

const config: PrivyClientConfig = {
  loginMethods: ['email', 'wallet', 'google'],
  appearance: { theme: 'light', accentColor: '#6A56A4', walletChainType: 'ethereum-only' },
  embeddedWallets: { ethereum: { createOnLogin: 'all-users' } },
  defaultChain: base,
  supportedChains: [base, arkivChain],
};

const unconfigured: Session = {
  configured: false, ready: true, authenticated: false, address: null, userLabel: null, error: null,
  login: () => {},
  logout: async () => {},
  signMessage: async () => { throw new Error(notConfigured); },
  getAccessToken: async () => null,
  getArkivWallet: async () => { throw new Error(notConfigured); },
};

export function SessionProvider({ children }: { children: ReactNode }) {
  if (!appId) return <SessionContext.Provider value={unconfigured}>{children}</SessionContext.Provider>;
  return <PrivyProvider appId={appId} config={config}><PrivySession>{children}</PrivySession></PrivyProvider>;
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession must be used inside <SessionProvider>.');
  return session;
}

const isEmbedded = (w: ConnectedWallet) => w.walletClientType === 'privy' || w.walletClientType === 'privy-v2';
const message = (e: unknown, fallback: string) => {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === 4001 || code === 'ACTION_REJECTED') return 'The signature request was declined.';
  return e instanceof Error && e.message.length < 200 ? e.message : fallback;
};

/** Rendered only inside PrivyProvider, so every Privy hook has its context. */
function PrivySession({ children }: { children: ReactNode }) {
  const { ready, authenticated, user, getAccessToken } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const [error, setError] = useState<string | null>(null);
  const { login: openLogin } = useLogin({
    onComplete: () => setError(null),
    onError: code => { if (code !== 'exited_auth_flow') setError('Sign-in did not complete. Try again.'); },
  });
  const { logout: privyLogout } = useLogout();

  // Only wallets Privy has linked to this user count; the server checks the same list.
  const linked = useMemo(() => new Set((user?.linkedAccounts ?? [])
    .flatMap(a => a.type === 'wallet' && a.chainType === 'ethereum' && isAddress(a.address) ? [a.address.toLowerCase()] : [])), [user]);
  const wallet = useMemo(() => {
    if (!authenticated || !walletsReady) return null;
    const usable = wallets.filter(w => w.type === 'ethereum' && linked.has(w.address.toLowerCase()));
    return usable.find(isEmbedded) ?? usable[0] ?? null;
  }, [authenticated, walletsReady, wallets, linked]);
  const address = wallet ? getAddress(wallet.address) : null;

  // Pending signatures compare against the latest address so a switched or signed-out
  // account can never receive a signature requested for the previous one.
  const current = useRef<{ address: Address | null; wallet: ConnectedWallet | null }>({ address: null, wallet: null });
  current.current = { address, wallet };
  useEffect(() => { if (!authenticated) setError(null); }, [authenticated, address]);

  const signMessage = useCallback(async (text: string): Promise<SignedMessage> => {
    const { address: signer, wallet: target } = current.current;
    if (!signer || !target) throw new Error('Sign in and wait for your wallet to be ready.');
    try {
      const provider = await target.getEthereumProvider();
      const signature: unknown = await provider.request({ method: 'personal_sign', params: [toHex(text), signer] });
      if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signature)) throw new Error('The wallet returned an invalid signature.');
      const recovered = await recoverMessageAddress({ message: text, signature: signature as `0x${string}` });
      if (recovered !== signer) throw new Error('The signature does not match your signed-in wallet.');
      if (current.current.address !== signer) throw new Error('Your account changed while signing. Try again.');
      return { address: signer, signature: signature as `0x${string}` };
    } catch (e) {
      const reason = message(e, 'Your wallet could not sign this request.');
      setError(reason);
      throw new Error(reason);
    }
  }, []);

  const logout = useCallback(async () => {
    try { await privyLogout(); setError(null); } catch { setError('Sign-out did not complete. Try again.'); }
  }, [privyLogout]);
  const accessToken = useCallback(async () => {
    if (!authenticated) return null;
    try { return await getAccessToken(); } catch { return null; }
  }, [authenticated, getAccessToken]);
  const login = useCallback(() => { setError(null); openLogin(); }, [openLogin]);
  const getArkivWallet = useCallback(async () => {
    const { address: signer, wallet: target } = current.current;
    if (!signer || !target) throw new Error('Sign in and wait for your wallet.');
    await target.switchChain(arkivChain.id);
    if (current.current.address !== signer) throw new Error('Your account changed. Try again.');
    const provider = await target.getEthereumProvider();
    return { address: signer, provider: provider as EIP1193Provider };
  }, []);

  const google = user?.google;
  const email = user?.email?.address;
  const value = useMemo<Session>(() => ({
    configured: true, ready, authenticated, error, login, logout, signMessage,
    address: authenticated ? address : null,
    userLabel: authenticated ? google?.name || google?.email || email || null : null,
    getAccessToken: accessToken, getArkivWallet,
  }), [ready, authenticated, address, google, email, error, login, logout, signMessage, accessToken, getArkivWallet]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
type Balance = { state: 'idle' | 'loading' | 'unavailable' } | { state: 'done'; display: string };

/** Base balance via the backend's authenticated /api/wallet route. Optional; shows "unavailable" until the host ships it. */
function useBaseBalance(enabled: boolean, address: Address | null, getAccessToken: Session['getAccessToken']): Balance {
  const [balance, setBalance] = useState<Balance>({ state: 'idle' });
  useEffect(() => {
    if (!enabled || !address) { setBalance({ state: 'idle' }); return; }
    const controller = new AbortController();
    setBalance({ state: 'loading' });
    (async () => {
      const token = await getAccessToken();
      if (!token) throw new Error('signed out');
      const response = await fetch(`${apiBase}/api/wallet?address=${address}`, {
        headers: { authorization: `Bearer ${token}` }, cache: 'no-store', signal: controller.signal,
      });
      if (!response.ok) throw new Error('unavailable');
      const body = await response.json() as { address?: unknown; display?: unknown };
      if (typeof body.address !== 'string' || body.address.toLowerCase() !== address.toLowerCase() || typeof body.display !== 'string') {
        throw new Error('invalid');
      }
      if (!controller.signal.aborted) setBalance({ state: 'done', display: body.display });
    })().catch(() => { if (!controller.signal.aborted) setBalance({ state: 'unavailable' }); });
    return () => controller.abort();
  }, [enabled, address, getAccessToken]);
  return balance;
}

export function SessionPanel({ showBalance = false }: { showBalance?: boolean }) {
  const session = useSession();
  const { configured, ready, authenticated, address, userLabel, error } = session;
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deletionStatus, setDeletionStatus] = useState('');
  const balance = useBaseBalance(showBalance && authenticated, address, session.getAccessToken);
  const signOut = async () => { setBusy(true); try { await session.logout(); } finally { setBusy(false); } };

  let status: string;
  if (!configured) status = notConfigured;
  else if (!ready) status = 'Checking your session…';
  else if (!authenticated) status = 'Not signed in';
  else if (!address) status = 'Setting up your wallet…';
  else status = 'Signed in';

  return (
    <section className="session-panel" aria-labelledby="session-title">
      <div className="session-head">
        <h2 id="session-title">Your account</h2>
        <span className={`session-pill${authenticated && address ? ' is-on' : ''}`} role="status">{status}</span>
      </div>
      {authenticated && (
        <dl className="session-facts">
          {userLabel && <div><dt>Account</dt><dd>{userLabel}</dd></div>}
          <div><dt>Wallet</dt><dd>{address ? <code title={address}>{address}</code> : '—'}</dd></div>
          {showBalance && address && <div><dt>Base balance</dt><dd>{
            balance.state === 'done' ? balance.display : balance.state === 'loading' ? 'Loading…' : 'Unavailable'}</dd></div>}
        </dl>
      )}
      {error && <p className="session-error" role="alert">{error}</p>}
      {configured && (authenticated
        ? <button type="button" className="session-btn session-btn-quiet" onClick={signOut} disabled={busy}>{busy ? 'Signing out…' : 'Sign out'}</button>
        : <button type="button" className="session-btn" onClick={session.login} disabled={!ready}>Sign in</button>)}
      {authenticated && address && <div className="session-delete">
        <button type="button" className="session-btn session-btn-quiet" disabled={busy || deleting} onClick={async () => {
          if (!window.confirm('Delete your Swipr account and wallet-owned Swipr data? Public blockchain history remains. Export your wallet first if it holds funds. This cannot be undone.')) return;
          setDeleting(true);
          try { await deleteWalletAccount(session, setDeletionStatus); setDeletionStatus('Your Swipr account was deleted.'); }
          catch (e) { setDeletionStatus(e instanceof Error ? e.message : 'Deletion could not be confirmed. You can retry.'); }
          finally { setDeleting(false); }
        }}>{deleting ? 'Deleting…' : 'Delete account and data'}</button>
        {deletionStatus && <p role="status">{deletionStatus}</p>}
      </div>}
    </section>
  );
}
