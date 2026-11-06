import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from '../auth/Session';
import type { SeatDirectory } from '../contracts/seats';
import { readSeats, leaveSeat, inviteFriend, revokeFriend } from '../lib/wallet-seats';
import './matches.css';
const short = (v: string) => `${v.slice(0, 6)}…${v.slice(-4)}`;
const empty = (): SeatDirectory => ({ passes: [], availability: [], invitations: [] });
const status = { joined: 'Joined', full: 'Waiting for a seat', not_invited: 'Invitation needed', expired: 'Expired', halted: 'Trader paused', duplicate: 'Duplicate seat' };
export default function Matches({ onDiscover, onJoin }: { onDiscover: () => void; onJoin: (traderId: string) => void }) {
  const session = useSession();
  const [directory, setDirectory] = useState<SeatDirectory>(empty);
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [busy, setBusy] = useState('');
  const [friends, setFriends] = useState<Record<string, string>>({});
  const epoch = useRef(0), account = session.address?.toLowerCase();
  const refresh = useCallback(async () => {
    const version = epoch.current;
    if (!session.authenticated || !session.address) return;
    try { const next = await readSeats(session); if (version === epoch.current) { setDirectory(next); setError(''); } }
    catch (e) { if (version === epoch.current) setError(e instanceof Error ? e.message : 'Could not load matches.'); }
    finally { if (version === epoch.current) setLoading(false); }
  }, [session.address, session.authenticated, session.getAccessToken]);
  useEffect(() => {
    epoch.current++; setDirectory(empty()); setError(''); setLoading(true); setBusy(''); setFriends({}); void refresh();
    const timer = setInterval(() => void refresh(), 30000); window.addEventListener('focus', refresh);
    return () => { epoch.current++; clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [refresh]);
  const act = async (id: string, action: () => Promise<SeatDirectory>) => {
    const version = epoch.current; setBusy(id); setError('');
    try { const next = await action(); if (version === epoch.current) setDirectory(next); }
    catch (e) { if (version === epoch.current) setError(e instanceof Error ? e.message : 'Seat update failed.'); }
    finally { if (version === epoch.current) setBusy(''); }
  };
  const myProfiles = directory.availability.filter(p => p.traderOwner === account);
  const invited = directory.availability.filter(p => p.invited && p.active && !directory.passes.some(pass => pass.traderId === p.traderId && pass.owner === account && pass.status === 'joined'));
  return <section className="content-page matches-page"><h1>Your matches<span>.</span></h1>
    {!session.authenticated ? <><p className="page-lead">Sign in to see your Copy Passes.</p><button className="primary-button" onClick={session.login}>Sign in</button></> : <>
      {error && <p role="alert">{error} <button className="text-button" onClick={() => void refresh()}>Retry</button></p>}
      {loading ? <p role="status">Loading your seats…</p> : <>
        {invited.map(p => <article className="match-card" key={p.traderId}><h2>{p.traderName} invited you</h2><p>{p.privateSeats - p.privateUsed} private seats available</p><button className="primary-button" disabled={p.privateUsed >= p.privateSeats} onClick={() => onJoin(p.traderId)}>Join private seat</button></article>)}
        {!directory.passes.length && !invited.length && <><p className="page-lead">Join a trader while seats are available.</p><button className="primary-button" onClick={onDiscover}>Meet a trader</button></>}
        <div className="match-list">{directory.passes.map(p => <article className="match-card" key={p.id}>
          <h2>{p.owner === account ? p.traderName : `${short(p.owner)} · ${p.traderName}`}</h2>
          <p>{status[p.status]} · {p.seatType === 'public' ? 'Public' : 'Private'}{p.seatNumber ? ` seat ${p.seatNumber}` : ''} · {p.terms.mode === 'tap' ? 'Review each trade' : 'Auto-copy requested'}</p>
          <dl><div><dt>Per trade</dt><dd>${p.terms.perTradeUsd}</dd></div><div><dt>Trades</dt><dd>{p.terms.tradeCount}</dd></div><div><dt>Budget</dt><dd>${p.terms.perTradeUsd * p.terms.tradeCount}</dd></div><div><dt>Ends</dt><dd>{new Date(p.expiresAt).toLocaleDateString()}</dd></div></dl>
          {p.owner === account && <button className="secondary-button" disabled={!!busy} onClick={() => void act(p.id, () => leaveSeat(session, p.id))}>{busy === p.id ? 'Leaving…' : 'Leave seat'}</button>}
        </article>)}</div>
        {myProfiles.map(p => <section className="match-card" key={p.traderId}>
          <h2>{p.traderName} seats</h2><p>Public {p.publicUsed}/{p.publicSeats} · Private {p.privateUsed}/{p.privateSeats}</p>
          <form className="match-actions" onSubmit={e => { e.preventDefault(); void act(p.traderId, () => inviteFriend(session, p.traderId, friends[p.traderId] || '')); }}>
            <label>Friend’s wallet<input className="match-wallet" required placeholder="0x…" value={friends[p.traderId] || ''} onChange={e => setFriends(v => ({ ...v, [p.traderId]: e.target.value }))} /></label>
            <button className="primary-button" disabled={!!busy || p.privateSeats === 0}>Invite friend</button>
          </form>
          {p.privateSeats === 0 && <p>Add private seats in your profile to invite friends.</p>}
          <ul className="match-invites">{directory.invitations.filter(i => i.traderId === p.traderId && i.status === 'active').map(i => <li key={i.entityKey}><span>{short(i.wallet)}</span><button className="text-button" disabled={!!busy} onClick={() => void act(i.entityKey, () => revokeFriend(session, i.entityKey))}>Revoke invite</button></li>)}</ul>
        </section>)}
      </>}
    </>}
  </section>;
}
