import { saveWalletProfile, haltWalletProfile } from '../lib/arkiv';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useSession } from '../auth/Session';
import {
  ASSETS, STRATEGIES, STYLES, buildAction, draftFrom, emptyDraft, getBots, getIntegration,
  LIMITS, loadLocalDraft, saveLocalDraft, short, snippets, toolName, upsertData, validateDraft,
} from '../lib/bots';
import type { BotProfile, BotsResponse, Integration, ProfileDraft } from '../lib/bots';
import '../bots.css';

/** onChanged fires after the service accepts an upsert or halt, so the host can refresh its directory. */
type Props = { onChanged?: () => void };
type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'done'; data: BotsResponse };
type Notice = { tone: 'ok' | 'error' | 'info'; text: string } | null;
type FieldErrors = Partial<Record<keyof ProfileDraft, string>>;

const STRATEGY_LABEL: Record<ProfileDraft['strategy'], string> = { 'rule-based': 'Rule-based', llm: 'LLM-assisted', manual: 'Manual' };
const time = (v?: string | number) => {
  if (v === undefined) return '';
  const d = new Date(typeof v === 'number' && v < 1e12 ? v * 1000 : v);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

function useOnline() {
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  return online;
}

function CopyBlock({ title, text, hint }: { title: string; text: string; hint?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const id = useId();
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setState('copied'); } catch { setState('failed'); }
    window.setTimeout(() => setState('idle'), 2000);
  };
  return (
    <section className="bs-copy" aria-labelledby={id}>
      <div className="bs-copy-head">
        <h3 id={id}>{title}</h3>
        <button type="button" className="bs-btn bs-btn-quiet" onClick={copy} aria-label={`Copy ${title}`}>
          {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'}
        </button>
      </div>
      {hint && <p className="bs-hint">{hint}</p>}
      <pre tabIndex={0} aria-label={`${title} snippet`}><code>{text}</code></pre>
      <span className="sr-only" aria-live="polite">{state === 'copied' ? `${title} copied to clipboard` : state === 'failed' ? 'Copy failed' : ''}</span>
    </section>
  );
}

export default function BotStudio({ onChanged }: Props = {}) {
  const online = useOnline();
  const session = useSession();
  const account = session.address?.toLowerCase() ?? null;
  const accountRef = useRef(account);
  accountRef.current = account;
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [integration, setIntegration] = useState<Integration | null>(null);
  const [integrationError, setIntegrationError] = useState('');
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [draftSource, setDraftSource] = useState<'new' | 'edit' | 'local'>('new');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [tick, setTick] = useState(0);
  const formTitle = useId();

  useEffect(() => {
    const local = loadLocalDraft();
    if (local) { setDraft(local); setDraftSource('local'); }
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoad(prev => (prev.kind === 'done' ? prev : { kind: 'loading' }));
    getBots(ctrl.signal)
      .then(data => setLoad({ kind: 'done', data }))
      .catch((e: unknown) => { if (!ctrl.signal.aborted) setLoad({ kind: 'error', message: e instanceof Error ? e.message : 'Could not load bots.' }); });
    getIntegration(ctrl.signal)
      .then(i => { setIntegration(i); setIntegrationError(''); })
      .catch((e: unknown) => { if (!ctrl.signal.aborted) setIntegrationError(e instanceof Error ? e.message : 'Integration details unavailable.'); });
    return () => ctrl.abort();
  }, [tick]);

  const [wasOffline, setWasOffline] = useState(false);
  useEffect(() => {
    if (!online) setWasOffline(true);
    else if (wasOffline) { setWasOffline(false); setTick(t => t + 1); }
  }, [online, wasOffline]);

  const refresh = useCallback(() => setTick(t => t + 1), []);

  const ensureReady = (): string | null => {
    if (!online) return 'You are offline. Reconnect to sign and submit.';
    if (!integration) return 'Integration details are unavailable, so the signing audience is unknown. Refresh and try again.';
    if (!account) return 'Sign in first.';
    return null;
  };

  const run = async (label: string, action: 'profile.upsert' | 'profile.halt', data: Parameters<typeof buildAction>[2], done: string, clearDraft = false) => {
    const blocked = ensureReady();
    if (blocked) { setNotice({ tone: 'error', text: blocked }); return; }
    const owner = account!;
    setBusy(label);
    setNotice({ tone: 'info', text: 'Preparing your wallet-owned Arkiv transaction…' });
    try {
      if (action === 'profile.upsert') await saveWalletProfile(session, data as Parameters<typeof saveWalletProfile>[1]);
      else await haltWalletProfile(session, (data as { profileId: string }).profileId);
      if (accountRef.current !== owner) return;
      if (clearDraft) { saveLocalDraft(null); setDraft(null); }
      setNotice({ tone: 'ok', text: done });
      refresh(); onChanged?.();
    } catch (e) {
      if (accountRef.current === owner) setNotice({ tone: 'error', text: e instanceof Error ? e.message : 'Your wallet could not confirm the transaction.' });
    } finally { setBusy(null); }
  };

  const update = (patch: Partial<ProfileDraft>) => {
    if (!draft) return;
    const next = { ...draft, ...patch };
    setDraft(next);
    if (draftSource !== 'edit') { saveLocalDraft(next); setDraftSource('local'); }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    const found = validateDraft(draft);
    setErrors(found);
    if (Object.keys(found).length) { setNotice({ tone: 'error', text: 'Fix the highlighted fields.' }); return; }
    await run('save', 'profile.upsert', upsertData(draft), draftSource === 'edit' ? 'Profile update accepted. Refreshing list…' : 'Registration accepted. Refreshing list…', true);
  };

  const data = load.kind === 'done' ? load.data : null;
  const profiles = data?.profiles ?? [];
  const signals = (data?.signals ?? []).slice(0, 12);
  const names = new Map(profiles.map(p => [p.id, p.name]));
  const isOwner = (p: BotProfile) => !!account && p.owner.toLowerCase() === account;
  const snip = snippets(integration);
  const locked = !!busy;

  return (
    <section className="bs" aria-labelledby="bs-title" aria-busy={load.kind === 'loading' || !!busy}>
      <header className="bs-head">
        <div>
          <h1 id="bs-title">Bot studio</h1>
          <p>Manage your trading bots and connect them over API or MCP.</p>
        </div>
        <div className="bs-head-actions">
          <button type="button" className="bs-btn bs-btn-quiet" onClick={refresh} disabled={load.kind === 'loading'} aria-label="Refresh bots">
            {load.kind === 'loading' ? 'Loading…' : 'Refresh'}
          </button>
          {account
            ? <span className="bs-chip" title={account}><span className="bs-dot" aria-hidden="true" />Owner {short(account)}</span>
            : session.authenticated
              ? <span className="bs-chip">Setting up your wallet…</span>
              : <button type="button" className="bs-btn" onClick={session.login} disabled={!session.configured || !session.ready}
                title={session.configured ? undefined : 'Sign-in is not configured for this deployment.'}>Sign in</button>}
        </div>
      </header>

      {!online && <p className="bs-banner bs-banner-warn" role="status">Offline. Showing the last loaded data; signing and submission are paused.</p>}
      {data?.state === 'unavailable' && <p className="bs-banner bs-banner-warn" role="status">Bot storage unavailable: {data.detail || 'no detail provided.'}</p>}
      {notice && <p className={`bs-banner bs-banner-${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.text}</p>}
      <div className="bs-grid">
        <section className="bs-panel" aria-labelledby="bs-list">
          <div className="bs-panel-head">
            <h2 id="bs-list">Registered bots</h2>
            <button type="button" className="bs-btn" onClick={() => { setDraft(emptyDraft(account ?? '')); setDraftSource('new'); setErrors({}); }}>
              New bot
            </button>
          </div>
          {load.kind === 'loading' && <p className="bs-empty" role="status">Loading bots from the service…</p>}
          {load.kind === 'error' && (
            <div className="bs-empty" role="alert">
              <p>{load.message}</p>
              <button type="button" className="bs-btn bs-btn-quiet" onClick={refresh}>Try again</button>
            </div>
          )}
          {data && !profiles.length && <p className="bs-empty">No bots are registered yet.</p>}
          {!!profiles.length && (
            <ul className="bs-list">
              {profiles.map(p => (
                <li key={p.id} className={`bs-row${p.status === 'halted' ? ' is-halted' : ''}`}>
                  <div className="bs-row-head">
                    <h3>{p.name}</h3>
                    <span className={`bs-status bs-status-${p.status}`}>{p.status === 'halted' ? 'Halted' : 'Active'}</span>
                    {isOwner(p) && <span className="bs-pill">Yours</span>}
                  </div>
                  {p.bio && <p className="bs-bio">{p.bio}</p>}
                  <dl className="bs-meta">
                    <div><dt>Style</dt><dd>{p.style}</dd></div>
                    <div><dt>Strategy</dt><dd>{STRATEGY_LABEL[p.strategy] ?? p.strategy}</dd></div>
                    <div><dt>Assets</dt><dd>{p.assets.join(', ')}</dd></div>
                    <div><dt>Owner</dt><dd title={p.owner}>{short(p.owner)}</dd></div>
                    <div><dt>Operator</dt><dd title={p.operator}>{short(p.operator)}</dd></div>
                    <div><dt>Updated</dt><dd>{time(p.updatedAt)}</dd></div>
                  </dl>
                  {isOwner(p) && p.status === 'active' && (
                    <div className="bs-row-actions">
                      <button type="button" className="bs-btn bs-btn-quiet" disabled={!!busy}
                        onClick={() => { setDraft(draftFrom(p)); setDraftSource('edit'); setErrors({}); }} aria-label={`Edit ${p.name}`}>Edit</button>
                      <button type="button" className="bs-btn bs-btn-danger" disabled={locked || !online} aria-label={`Halt ${p.name}`}
                        onClick={() => {
                          if (window.confirm(`Halt ${p.name}? New signals will no longer appear in Swipr.`)) {
                            void run(p.id, 'profile.halt', { profileId: p.id }, `${p.name} halted; new signals will no longer appear.`);
                          }
                        }}>
                        {busy === p.id ? 'Signing…' : 'Halt'}
                      </button>
                    </div>
                  )}
                  {isOwner(p) && p.status === 'halted' && <p className="bs-hint bs-row-actions">This bot is halted and cannot publish new signals in Swipr.</p>}
                </li>
              ))}
            </ul>
          )}
        </section>

        {draft && (
          <section className="bs-panel" aria-labelledby={formTitle}>
            <div className="bs-panel-head">
              <h2 id={formTitle}>{draftSource === 'edit' ? `Edit ${draft.name || 'bot'}` : 'Register a bot'}</h2>
              {draftSource === 'local' && <span className="bs-pill bs-pill-quiet">Local draft — not stored</span>}
            </div>
            <form className="bs-form" onSubmit={submit} noValidate>
              <label className="bs-field">
                <span>Name</span>
                <input value={draft.name} maxLength={LIMITS.nameMax} onChange={e => update({ name: e.target.value })}
                  aria-invalid={!!errors.name} aria-describedby={errors.name ? 'bs-e-name' : undefined} required />
                {errors.name && <small id="bs-e-name" className="bs-error">{errors.name}</small>}
              </label>
              <label className="bs-field">
                <span>Operator address</span>
                <input value={draft.operator} spellCheck={false} autoComplete="off" placeholder="0x…" onChange={e => update({ operator: e.target.value })}
                  aria-invalid={!!errors.operator} aria-describedby={errors.operator ? 'bs-e-op' : 'bs-h-op'} required />
                {errors.operator
                  ? <small id="bs-e-op" className="bs-error">{errors.operator}</small>
                  : <small id="bs-h-op" className="bs-hint">The key that signs signals. Your signed-in wallet ({account ? short(account) : 'not signed in'}) controls edits and halts.</small>}
              </label>
              <label className="bs-field">
                <span>Bio</span>
                <textarea value={draft.bio} rows={3} maxLength={LIMITS.bioMax} onChange={e => update({ bio: e.target.value })}
                  aria-invalid={!!errors.bio} aria-describedby="bs-h-bio" />
                <small id="bs-h-bio" className={errors.bio ? 'bs-error' : 'bs-hint'}>{errors.bio ?? `${draft.bio.length}/${LIMITS.bioMax}`}</small>
              </label>
              <div className="bs-row-2">
                <label className="bs-field">
                  <span>Style</span>
                  <select value={draft.style} onChange={e => update({ style: e.target.value as ProfileDraft['style'] })}>
                    {STYLES.map(s => <option key={s}>{s}</option>)}
                  </select>
                </label>
                <label className="bs-field">
                  <span>Strategy</span>
                  <select value={draft.strategy} onChange={e => update({ strategy: e.target.value as ProfileDraft['strategy'] })}>
                    {STRATEGIES.map(s => <option key={s} value={s}>{STRATEGY_LABEL[s]}</option>)}
                  </select>
                </label>
              </div>
              <fieldset className="bs-field" aria-describedby={errors.assets ? 'bs-e-assets' : undefined}>
                <legend>Assets</legend>
                <div className="bs-checks">
                  {ASSETS.map(a => (
                    <label key={a} className="bs-check">
                      <input type="checkbox" checked={draft.assets.includes(a)}
                        onChange={e => update({ assets: e.target.checked ? ASSETS.filter(x => x === a || draft.assets.includes(x)) : draft.assets.filter(x => x !== a) })} />
                      {a}
                    </label>
                  ))}
                </div>
                {errors.assets && <small id="bs-e-assets" className="bs-error">{errors.assets}</small>}
              </fieldset>
              <p className="bs-hint">Approve the Arkiv transaction in your wallet to save your profile.</p>
              <div className="bs-row-actions">
                <button type="submit" className="bs-btn" disabled={locked || !online || !account}>
                  {busy === 'save' ? 'Signing…' : account ? 'Sign & save' : 'Sign in to save'}
                </button>
                <button type="button" className="bs-btn bs-btn-quiet" disabled={!!busy}
                  onClick={() => { if (draftSource !== 'edit') saveLocalDraft(null); setDraft(null); setErrors({}); }}>
                  {draftSource === 'edit' ? 'Cancel' : 'Discard draft'}
                </button>
              </div>
            </form>
          </section>
        )}

        <section className="bs-panel" aria-labelledby="bs-activity">
          <div className="bs-panel-head">
            <h2 id="bs-activity">Recent signals</h2>
            <span className="bs-pill bs-pill-quiet">Proposals only</span>
          </div>
          {data && !signals.length && <p className="bs-empty">No signals published yet.</p>}
          {!data && <p className="bs-empty">{load.kind === 'loading' ? 'Loading…' : 'Unavailable.'}</p>}
          {!!signals.length && (
            <ul className="bs-activity">
              {signals.map(s => (
                <li key={s.id}>
                  <span className={`bs-side bs-side-${s.side}`}>{s.side}</span>
                  <span><strong>{s.quantity} {s.asset}</strong> limit {s.limitPrice}</span>
                  <span className="bs-hint">{names.get(s.profileId) ?? short(s.profileId)} · {time(s.createdAt)}</span>
                  {s.thesis && <span className="bs-thesis">{s.thesis}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="bs-panel bs-panel-wide" aria-labelledby="bs-connect">
          <div className="bs-panel-head">
            <h2 id="bs-connect">Connect your bot</h2>
            <span className="bs-pill bs-pill-quiet">Trading disabled</span>
          </div>
          {integrationError
            ? <p className="bs-banner bs-banner-warn" role="status">Integration details unavailable: {integrationError} Snippets below use placeholder URLs.</p>
            : integration && (
              <div className="bs-integration-info bs-hint">
                <p>Audience <code>{integration.audience}</code></p>
                <details><summary>Available tools</summary><p>{integration.tools.map(toolName).join(', ') || 'None available'}</p></details>
              </div>
            )}
          <div className="bs-copies">
            <CopyBlock title="curl" text={snip.curl} hint="Read profiles and prepare a wallet transaction." />
            <CopyBlock title="MCP config" text={snip.mcp} hint="Stateless JSON-RPC over HTTP." />
            <CopyBlock title="Signal example" text={snip.example} hint="Signed by the registered operator key." />
          </div>
        </section>
      </div>
    </section>
  );
}
