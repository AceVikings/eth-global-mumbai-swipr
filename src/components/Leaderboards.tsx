import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { socialMessage } from '../../shared/social';
import { useSession } from '../auth/Session';
import {
  ADDRESS, PREVIEW_AVATARS, PREVIEW_ROWS, SocialError, buildSocialAction, formatPct, formatUsd, getLeaderboard, getSocial,
  loadPreviewFollows, rankBy, same, savePreviewFollows, sendSocialCommand, short,
} from '../lib/social';
import type { LeaderboardRow, Role, Scope, SignedSocialAction, Sort } from '../lib/social';
import '../social.css';

type Board = { status: 'loading' } | { status: 'error'; message: string } | { status: 'unavailable'; detail: string }
  | { status: 'ready'; rows: LeaderboardRow[]; asOf: string | null };
type Following = { status: 'idle' | 'loading' } | { status: 'error' | 'unavailable'; message: string }
  | { status: 'ready'; list: string[]; audience: string };
type Notice = { tone: 'ok' | 'error' | 'info'; text: string } | null;

const ROLES: [Role, string][] = [['trader', 'Traders'], ['copier', 'Copiers']];
const SORTS: [Sort, string][] = [['percentage', 'Return %'], ['absolute', 'Net profit']];
const SCOPES: [Scope, string][] = [['everyone', 'Everyone'], ['following', 'Following']];

function Tabs<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="lb-tabs" role="group" aria-label={label}>
      {options.map(([v, text]) => <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)}>{text}</button>)}
    </div>
  );
}

export default function Leaderboards({ mode }: { mode: 'preview' | 'live' }) {
  const session = useSession();
  const live = mode === 'live';
  const wallet = live && session.authenticated ? session.address : null;
  const [role, setRole] = useState<Role>('trader');
  const [sort, setSort] = useState<Sort>('percentage');
  const [scope, setScope] = useState<Scope>('everyone');
  const [board, setBoard] = useState<Board>({ status: 'loading' });
  const [following, setFollowing] = useState<Following>({ status: 'idle' });
  const [previewFollows, setPreviewFollows] = useState<string[]>(() => (live ? [] : loadPreviewFollows()));
  const [pending, setPending] = useState<{ signed: SignedSocialAction; wallet: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [selected, setSelected] = useState<LeaderboardRow | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (selected) dialogRef.current?.showModal();
    else dialogRef.current?.close();
  }, [selected]);
  const [draft, setDraft] = useState('');
  const [reload, setReload] = useState(0);
  const { getAccessToken } = session;
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6500);
    return () => clearTimeout(timer);
  }, [notice]);

  // A switched or signed-out account must never send the previous account's envelope.
  const walletRef = useRef(wallet);
  walletRef.current = wallet;
  useEffect(() => {
    if (pending && (!wallet || !same(pending.wallet, wallet))) {
      setPending(null);
      setNotice({ tone: 'info', text: 'Your account changed, so the unconfirmed follow request was discarded. Check the list and try again if needed.' });
    }
  }, [wallet, pending]);

  useEffect(() => {
    if (!live || !wallet) { setFollowing({ status: 'idle' }); return; }
    const controller = new AbortController();
    setFollowing({ status: 'loading' });
    (async () => {
      const token = await getAccessToken();
      if (!token) throw new SocialError('Sign in again to load who you follow.', false);
      const value = await getSocial(wallet, token, controller.signal);
      if (controller.signal.aborted) return;
      setFollowing(value.state === 'ready'
        ? { status: 'ready', list: value.following, audience: value.audience }
        : { status: 'unavailable', message: value.detail || 'Following is unavailable right now.' });
    })().catch(e => { if (!controller.signal.aborted) setFollowing({ status: 'error', message: e instanceof Error ? e.message : 'Could not load who you follow.' }); });
    return () => controller.abort();
  }, [live, wallet, getAccessToken, reload]);

  useEffect(() => {
    if (!live) return;
    if (scope === 'following' && !wallet) { setBoard({ status: 'ready', rows: [], asOf: null }); return; }
    const controller = new AbortController();
    setBoard({ status: 'loading' });
    (async () => {
      const token = scope === 'following' ? await getAccessToken() : null;
      if (scope === 'following' && !token) throw new SocialError('Sign in again to see people you follow.', false);
      const value = await getLeaderboard({ role, sort, scope, wallet }, token, controller.signal);
      if (controller.signal.aborted) return;
      setBoard(value.state === 'ready'
        ? { status: 'ready', rows: value.rows, asOf: value.asOf }
        : { status: 'unavailable', detail: value.detail || 'Rankings appear once verified fills are recorded.' });
    })().catch(e => { if (!controller.signal.aborted) setBoard({ status: 'error', message: e instanceof Error ? e.message : 'Could not load rankings.' }); });
    return () => controller.abort();
  }, [live, role, sort, scope, wallet, getAccessToken, reload]);

  const followList = live ? (following.status === 'ready' ? following.list : []) : previewFollows;
  const isFollowed = useCallback((a: string) => followList.some(f => same(f, a)), [followList]);

  const view = useMemo((): Board => {
    if (live) return board;
    const rows = PREVIEW_ROWS.filter(r => r.kind === role && (scope === 'everyone' || isFollowed(r.address)));
    return { status: 'ready', rows: rankBy(rows, sort), asOf: null };
  }, [live, board, role, sort, scope, isFollowed]);
  const knownNames = useMemo(() => new Map((live ? (board.status === 'ready' ? board.rows : []) : PREVIEW_ROWS)
    .map(r => [r.address.toLowerCase(), r.name])), [live, board]);

  const submit = async (signed: SignedSocialAction, owner: string) => {
    setBusy(true);
    try {
      const token = await getAccessToken();
      if (!token) throw new SocialError('Sign in again to send this request.', false);
      if (!walletRef.current || !same(walletRef.current, owner)) throw new SocialError('Your account changed before sending.', false);
      await sendSocialCommand(signed, token);
      setPending(null);
      setNotice({ tone: 'ok', text: `${signed.payload.action === 'follow' ? 'Following' : 'Unfollowed'} ${short(signed.payload.target)}.` });
      setReload(n => n + 1);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'The request failed.';
      if (e instanceof SocialError && e.uncertain && walletRef.current && same(walletRef.current, owner)) {
        setPending({ signed, wallet: owner });
        setNotice({ tone: 'error', text: `${message} It may or may not have applied. Retry sends the same signed request.` });
      } else {
        setPending(null);
        setNotice({ tone: 'error', text: message });
      }
    } finally { setBusy(false); }
  };

  const act = async (action: 'follow' | 'unfollow', target: string) => {
    if (!ADDRESS.test(target)) { setNotice({ tone: 'error', text: 'Enter a 0x wallet address (40 hex characters).' }); return; }
    if (!live) {
      const next = action === 'follow' ? [...previewFollows.filter(f => !same(f, target)), target] : previewFollows.filter(f => !same(f, target));
      setPreviewFollows(next); savePreviewFollows(next);
      setNotice({ tone: 'info', text: `Preview only: ${action === 'follow' ? 'followed' : 'unfollowed'} ${short(target)} on this device. Nothing was sent.` });
      return;
    }
    if (!session.authenticated || !wallet) { session.login(); return; }
    if (pending || busy) return;
    if (following.status !== 'ready') { setNotice({ tone: 'error', text: 'Following is unavailable, so changes cannot be sent right now.' }); return; }
    if (same(target, wallet)) { setNotice({ tone: 'error', text: 'You cannot follow your own wallet.' }); return; }
    const payload = buildSocialAction(following.audience, action, target);
    setBusy(true);
    let signed: SignedSocialAction;
    try {
      signed = { payload, signature: (await session.signMessage(socialMessage(payload))).signature };
    } catch (e) {
      setBusy(false);
      setNotice({ tone: 'error', text: e instanceof Error ? e.message : 'The signature was not created.' });
      return;
    }
    await submit(signed, wallet);
  };

  const onAdd = (e: FormEvent) => {
    e.preventDefault();
    const target = draft.trim();
    if (ADDRESS.test(target)) setDraft('');
    void act('follow', target);
  };
  const locked = live && (busy || !!pending);
  const needsAuth = live && !wallet;

  const followButton = (address: string) => {
    const on = isFollowed(address);
    return (
      <button type="button" className={`lb-follow-action${on ? ' is-following' : ''}`} disabled={locked || (!!wallet && same(address, wallet))}
        onClick={() => void act(on ? 'unfollow' : 'follow', address)} aria-label={`${on ? 'Unfollow' : 'Follow'} ${address}`}>
        {on ? 'Following' : '+ Follow'}
      </button>
    );
  };

  const avatar = (r: LeaderboardRow) => {
    const photo = !live ? PREVIEW_AVATARS[r.address.toLowerCase()] : undefined;
    return photo ? <img className="lb-avatar" src={photo} alt="" />
      : <span className="lb-avatar lb-initial" aria-hidden="true">{r.name.trim().slice(0, 1).toUpperCase()}</span>;
  };

  return (
    <section className="lb" aria-labelledby="lb-title">
      <header className="lb-head">
        <h1 id="lb-title">Leaderboards</h1>
        <details className="lb-info">
          <summary aria-label="How profit is measured">?</summary>
          <div>
            <p><strong>Net profit</strong> is realized profit on closed positions after trading fees and profit share.</p>
            <p><strong>Return %</strong> is that net profit divided by entry cost, weighted by position size.</p>
            <p>Both cover the same interval since inception. Open positions, ghost copies and proposed signals are excluded.</p>
            <p>Following someone is free and does not copy trades.</p>
            {!live && <p>These figures are illustrative samples. Preview follows stay on this device.</p>}
          </div>
        </details>
      </header>

      <div className="lb-roles"><Tabs label="Leaderboard" value={role} options={ROLES} onChange={setRole} /></div>
      <div className="lb-toolbar">
        <Tabs label="Show" value={scope} options={SCOPES} onChange={setScope} />
        <label className="lb-sort">Sort:
          <select aria-label="Sort leaderboard" value={sort} onChange={e => setSort(e.target.value as Sort)}>
            {SORTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      </div>

      {notice && <p className={`lb-banner lb-banner-${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.text}</p>}
      {pending && <div className="lb-banner lb-banner-error lb-pending" role="alert">
        <span>Follow request unconfirmed. Retry the same request to check its outcome.</span>
        <button type="button" className="lb-btn" disabled={busy} onClick={() => void submit(pending.signed, pending.wallet)}>{busy ? 'Retrying…' : 'Retry same request'}</button>
      </div>}

      <div className="lb-board">
        {view.status === 'loading' && <p className="lb-empty" role="status">Loading rankings…</p>}
        {view.status === 'error' && <div className="lb-empty lb-error" role="alert"><p>Rankings could not be loaded: {view.message}</p><button className="lb-btn" onClick={() => setReload(n => n + 1)}>Try again</button></div>}
        {view.status === 'unavailable' && <p className="lb-empty" role="status"><strong>Rankings unavailable.</strong> {view.detail}</p>}
        {view.status === 'ready' && (scope === 'following' && needsAuth
          ? <div className="lb-empty"><p>Sign in with Google to see people you follow.</p><button type="button" className="lb-btn" onClick={session.login}>Continue with Google</button></div>
          : view.rows.length === 0
            ? <div className="lb-empty" role="status"><p>{scope === 'following' ? 'Nobody you follow has closed positions on this board yet.' : 'No ranked accounts yet.'}</p>{scope === 'following' && <button className="text-button" onClick={() => setScope('everyone')}>Explore everyone</button>}</div>
            : <table className="lb-table">
              <caption className="lb-sr">{role === 'trader' ? 'Trader' : 'Copier'} leaderboard sorted by {sort === 'percentage' ? 'return percentage' : 'net profit'}</caption>
              <colgroup><col className="lb-rank-col" /><col /><col className="lb-metric-col" /><col className="lb-metric-col" /><col className="lb-action-col" /></colgroup>
              <thead><tr>
                <th scope="col">Rank</th><th scope="col">{role === 'trader' ? 'Trader' : 'Copier'}</th>
                <th scope="col" aria-sort={sort === 'percentage' ? 'descending' : 'none'}>Return %</th>
                <th scope="col" aria-sort={sort === 'absolute' ? 'descending' : 'none'}>Net profit</th>
                <th scope="col"><span className="lb-sr">Follow</span></th>
              </tr></thead>
              <tbody>{view.rows.map((r, i) => <tr key={r.address}>
                <td className="lb-rank">{i + 1}</td>
                <td><button className="lb-person" onClick={() => setSelected(r)} aria-label={`View ${r.name}'s profile`}>{avatar(r)}<span>{r.name}</span></button></td>
                <td className={`lb-num${sort === 'percentage' ? ' is-sorted' : ''}${Number(r.returnPct) < 0 ? ' is-loss' : ''}`}>{formatPct(r.returnPct)}</td>
                <td className={`lb-num${sort === 'absolute' ? ' is-sorted' : ''}${Number(r.netProfitUsd) < 0 ? ' is-loss' : ''}`}>{formatUsd(r.netProfitUsd)}</td>
                <td>{followButton(r.address)}</td>
              </tr>)}</tbody>
            </table>)}
      </div>
      <footer className="lb-footer">
        <p>{!live && 'Sample figures · '}Net profit after fees · closed positions</p>
        {view.status === 'ready' && view.asOf && <p>As of {new Date(view.asOf).toLocaleString()}</p>}
      </footer>

      <details className="lb-manage">
        <summary>Manage following</summary>
        <div className="lb-manage-body">
          <form className="lb-add" onSubmit={onAdd}>
            <label htmlFor="lb-address">Follow a wallet address</label>
            <div><input id="lb-address" value={draft} onChange={e => setDraft(e.target.value)} placeholder="0x…" spellCheck={false} autoComplete="off" />
              <button type="submit" className="lb-btn" disabled={locked || (live && !!wallet && following.status !== 'ready')}>{needsAuth ? 'Sign in' : 'Follow'}</button></div>
          </form>
          {live && needsAuth && <p className="lb-muted">Sign in with Google to follow people.</p>}
          {live && following.status === 'loading' && <p className="lb-muted" role="status">Loading who you follow…</p>}
          {live && (following.status === 'error' || following.status === 'unavailable') && <p className="lb-error" role="alert">Following unavailable: {following.message}</p>}
          {(!live || following.status === 'ready') && (followList.length === 0 ? <p className="lb-muted">You are not following anyone yet.</p>
            : <ul className="lb-list">{followList.map(a => <li key={a}><span>{knownNames.get(a.toLowerCase()) || short(a)}</span><button type="button" className="lb-follow-action is-following" disabled={locked} onClick={() => void act('unfollow', a)} aria-label={`Unfollow ${a}`}>Unfollow</button></li>)}</ul>)}
          {!live && <p className="lb-muted">Preview follows stay on this device. No request is sent.</p>}
        </div>
      </details>

      <dialog ref={dialogRef} className="lb-profile" aria-labelledby="lb-profile-title" onCancel={() => setSelected(null)} onClick={e => { if (e.target === e.currentTarget) setSelected(null); }}>
        {selected && <div>
          <button autoFocus className="lb-close text-button" onClick={() => setSelected(null)}>Close</button>
          <div className="lb-profile-person">{avatar(selected)}<h2 id="lb-profile-title">{selected.name}</h2></div>
          <dl>
            <div><dt>Wallet</dt><dd><code>{selected.address}</code></dd></div>
            <div><dt>Return</dt><dd>{formatPct(selected.returnPct)}</dd></div>
            <div><dt>Net profit</dt><dd>{formatUsd(selected.netProfitUsd)}</dd></div>
            <div><dt>Closed positions</dt><dd>{selected.closedPositions}</dd></div>
          </dl>
          {followButton(selected.address)}
          <p className="lb-muted">{live ? 'Based on verified closed positions.' : 'Illustrative profile and sample figures.'} Following does not start a Copy Pass.</p>
        </div>}
      </dialog>
    </section>
  );
}
