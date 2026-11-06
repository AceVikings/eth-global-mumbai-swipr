import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from '../auth/Session';
import type { WalletPass } from '../contracts/passes';
import { readWalletPasses, respondWalletPass } from '../lib/wallet-passes';
import './matches.css';
const short = (v: string) => `${v.slice(0, 6)}…${v.slice(-4)}`;
export default function Matches({ onDiscover }: { onDiscover: () => void }) {
  const session = useSession();
  const [passes, setPasses] = useState<WalletPass[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const account = session.address?.toLowerCase();
  const epoch = useRef(0);
  const refresh = useCallback(async () => {
    const version = epoch.current;
    if (!session.authenticated || !session.address) return;
    try { const next = await readWalletPasses(session); if (version === epoch.current) { setPasses(next); setError(''); } }
    catch (e) { if (version === epoch.current) setError(e instanceof Error ? e.message : 'Could not load matches.'); }
    finally { if (version === epoch.current) setLoading(false); }
  }, [session.address, session.authenticated, session.getAccessToken]);
  useEffect(() => {
    epoch.current++; setPasses([]); setError(''); setLoading(true); setBusy(''); void refresh();
    const timer = setInterval(() => void refresh(), 30000);
    window.addEventListener('focus', refresh);
    return () => { epoch.current++; clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [refresh]);
  const act = async (id: string, action: Parameters<typeof respondWalletPass>[2]) => {
    const version = epoch.current; setBusy(id); setError('');
    try { const next = await respondWalletPass(session, id, action); if (version === epoch.current) setPasses(next); }
    catch (e) { if (version === epoch.current) setError(e instanceof Error ? e.message : 'Pass update failed.'); }
    finally { if (version === epoch.current) setBusy(''); }
  };
  return <section className="content-page matches-page">
    <h1>Your matches<span>.</span></h1>
    {!session.authenticated ? <><p className="page-lead">Sign in to see your Copy Passes and trader requests.</p><button className="primary-button" onClick={session.login}>Sign in</button></>
      : <>
        {error && <p role="alert">{error} <button className="text-button" onClick={() => void refresh()}>Retry</button></p>}
        {loading ? <p role="status">Loading your passes…</p> : passes.length === 0 ? <><p className="page-lead">Find a trader and request your first Copy Pass.</p><button className="primary-button" onClick={onDiscover}>Meet a trader</button></> :
          <div className="match-list">{passes.map(p => {
            const incoming = account === p.traderOwner;
            return <article className="match-card" key={p.id}>
              <div><h2>{incoming ? `Request from ${short(p.owner)}` : `Pass with ${p.traderName}`}</h2><p>{incoming ? `${p.traderName} · ` : ''}{p.status === 'pending' ? 'Awaiting trader response' : p.status[0].toUpperCase() + p.status.slice(1)} · {p.terms.mode === 'tap' ? 'Review each trade' : 'Automatic copying requested'}</p></div>
              <dl><div><dt>Per trade</dt><dd>${p.terms.perTradeUsd}</dd></div><div><dt>Trades</dt><dd>{p.terms.tradeCount}</dd></div><div><dt>Total budget</dt><dd>${p.terms.perTradeUsd * p.terms.tradeCount}</dd></div><div><dt>Duration</dt><dd>{p.terms.durationDays} days</dd></div></dl>
              {p.expiresAt && <p>Ends {new Date(p.expiresAt).toLocaleString()}</p>}
              <div className="match-actions">
                {incoming && p.status === 'pending' && <><button className="primary-button" disabled={!!busy} onClick={() => void act(p.id, 'accepted')}>Accept request</button><button className="secondary-button" disabled={!!busy} onClick={() => void act(p.id, 'declined')}>Decline</button></>}
                {incoming && p.status === 'accepted' && <button className="secondary-button" disabled={!!busy} onClick={() => void act(p.id, 'ended')}>End pass</button>}
                {!incoming && ['pending', 'accepted'].includes(p.status) && <button className="secondary-button" disabled={!!busy} onClick={() => void act(p.id, 'cancelled')}>{p.status === 'pending' ? 'Cancel request' : 'End pass'}</button>}
                {busy === p.id && <span role="status">Saving…</span>}
              </div>
            </article>;
          })}</div>}
      </>}
  </section>;
}
