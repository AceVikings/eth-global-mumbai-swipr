import { useEffect, useMemo, useRef, useState } from 'react';
import type { Session } from './Session';
import { createAccountGhostStore, walletGhostIO } from '../lib/wallet-ghosts';
export function useWalletGhosts(session: Session) {
  const current = useRef(session);
  current.current = session;
  const owner = session.authenticated ? session.address?.toLowerCase() : null;
  const store = useMemo(() => owner ? createAccountGhostStore(walletGhostIO(() => {
    if (current.current.address?.toLowerCase() !== owner || !current.current.authenticated) throw new Error('Your account changed. Try again.');
    return current.current;
  })) : null, [owner]);
  const [view, setView] = useState({ store, snapshot: store?.getSnapshot() });
  useEffect(() => {
    if (!store) { setView({ store, snapshot: undefined }); return; }
    const unsubscribe = store.subscribe(snapshot => setView({ store, snapshot }));
    void store.refresh();
    const refresh = () => { if (document.visibilityState === 'visible') void store.refresh(); };
    const interval = setInterval(refresh, 30000);
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    return () => { unsubscribe(); clearInterval(interval); window.removeEventListener('focus', refresh); window.removeEventListener('online', refresh); };
  }, [store]);
  const snapshot = view.store === store ? view.snapshot : store?.getSnapshot();
  return { store, ghosts: snapshot?.ghosts ?? [], loading: snapshot?.loading ?? false,
    busy: snapshot?.busy ?? false, error: snapshot?.error ?? '' };
}
