import { portraitFallback } from '../lib/profile-images';
import { short as shortWallet } from '../lib/bots';
import { useSession } from '../auth/Session';
import { joinSeat, readSeats } from '../lib/wallet-seats';
import type { SeatAvailability, SeatType } from '../contracts/seats';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DEFAULT_TERMS, type Mode, type Terms, type Trader } from '../contracts/types';
import '../pass-setup.css';

type Props = { trader: Trader; onClose: () => void };
type Step = 'edit' | 'review' | 'wallet';
type Draft = {
  count: string; durationDays: Terms['durationDays']; mode: Mode;
};
type Frozen = { terms: Terms; frozenAt: number };

const DURATIONS = [1, 7, 30] as const;
const draftKey = (id: string) => `swipr.passDraft.v1.${id}`;

const parseInt_ = (s: string, lo: number, hi: number) =>
  /^\d+$/.test(s.trim()) && +s >= lo && +s <= hi ? +s : null;
const clampInt = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));
const usd = (n: number) => `$${n.toLocaleString('en-US')}`;
const when = (ms: number) =>
  new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(ms);

function freshDraft(): Draft {
  return {
    count: String(DEFAULT_TERMS.tradeCount), durationDays: DEFAULT_TERMS.durationDays, mode: 'tap',
  };
}

function loadDraft(traderId: string): { draft: Draft; savedAt: number } | null {
  try {
    const raw = localStorage.getItem(draftKey(traderId));
    if (!raw) return null;
    const d = JSON.parse(raw) as Draft & { savedAt: number };
    if (!d || typeof d !== 'object' || !Number.isSafeInteger(d.savedAt) || d.savedAt < 0 || d.savedAt > Date.now() + 300_000 || !DURATIONS.includes(d.durationDays)) return null;
    return {
      savedAt: d.savedAt,
      draft: {
        count: String(d.count), durationDays: d.durationDays, mode: d.mode === 'auto' ? 'auto' : 'tap',
      },
    };
  } catch {
    return null;
  }
}

function Stepper(props: {
  id: string; label: string; hint: string; value: string; min: number; max: number;
  prefix?: string; suffix?: string; big?: boolean; error: string | null; disabled?: boolean;
  onChange: (v: string) => void;
}) {
  const { id, label, hint, value, min, max, prefix, suffix, big, error, onChange } = props;
  const n = parseInt_(value, min, max);
  const step = (d: number) => onChange(String(clampInt((n ?? (d > 0 ? min - 1 : max + 1)) + d, min, max)));
  return (
    <div className={`ps-field${big ? ' ps-field-big' : ''}`}>
      <label htmlFor={id} className="ps-label">{label}</label>
      <div className="ps-stepper">
        <button type="button" className="ps-step" aria-label={`Decrease ${label.toLowerCase()}`}
          onClick={() => step(-1)} disabled={n !== null && n <= min}>−</button>
        <div className="ps-input-wrap">
          {prefix && <span className="ps-affix" aria-hidden="true">{prefix}</span>}
          <input id={id} className="ps-input" type="number" inputMode="numeric" step={1} min={min} max={max}
            value={value} onChange={(e) => onChange(e.target.value)}
            aria-invalid={error ? true : undefined} aria-describedby={`${id}-hint${error ? ` ${id}-err` : ''}`} />
          {suffix && <span className="ps-affix ps-suffix" aria-hidden="true">{suffix}</span>}
        </div>
        <button type="button" className="ps-step" aria-label={`Increase ${label.toLowerCase()}`}
          onClick={() => step(1)} disabled={n !== null && n >= max}>+</button>
      </div>
      <p id={`${id}-hint`} className="ps-hint">{hint}</p>
      {error && <p id={`${id}-err`} className="ps-error" role="alert">{error}</p>}
    </div>
  );
}

function Choice<T extends string | number>(props: {
  legend: string; name: string; value: T; options: { value: T; label: string; sub?: string }[];
  onChange: (v: T) => void; wide?: boolean;
}) {
  return (
    <fieldset className="ps-fieldset">
      <legend className="ps-label">{props.legend}</legend>
      <div className={props.wide ? 'ps-options-wide' : 'ps-segmented'}>
        {props.options.map((o) => (
          <label key={String(o.value)} className="ps-option">
            <input type="radio" name={props.name} checked={props.value === o.value}
              onChange={() => props.onChange(o.value)} />
            <span className="ps-option-body"><b>{o.label}</b>{o.sub && <small>{o.sub}</small>}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="ps-row"><dt>{label}</dt><dd>{children}</dd></div>
);

export default function PassSetup({ trader, onClose }: Props) {
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [pool, setPool] = useState<SeatAvailability | null>(null);
  const [seatType, setSeatType] = useState<SeatType>('public');
  useEffect(() => {
    let active = true; setPool(null); setSeatType('public');
    if (session.address) void readSeats(session).then(value => {
      if (!active) return; const next = value.availability.find(p => p.traderId === trader.id);
      setPool(next ?? null); if (next?.invited) setSeatType('private');
    }).catch(() => { if (active) setStatus('Seats could not be loaded. Try again shortly.'); });
    return () => { active = false; };
  }, [session.address, trader.id]);
  const [stored] = useState(() => loadDraft(trader.id));
  const [d, setD] = useState<Draft>(() => stored?.draft ?? freshDraft());
  const [step, setStep] = useState<Step>('edit');
  const [frozen, setFrozen] = useState<Frozen | null>(null);
  const [ack, setAck] = useState(false);
  const [status, setStatus] = useState(stored ? `Loaded your local draft from ${when(stored.savedAt)}.` : '');
  const headingRef = useRef<HTMLHeadingElement>(null);
  const first = trader.name;
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((p) => ({ ...p, [k]: v }));

  const amount = 5;
  const count = parseInt_(d.count, 1, 20);
  const cap = amount && count ? amount * count : null;
  const breakup = Math.min(DEFAULT_TERMS.breakupUsd, cap ?? DEFAULT_TERMS.breakupUsd);
  const valid = amount === 5 && count !== null;

  useEffect(() => {
    headingRef.current?.focus();
    window.scrollTo({ top: 0 });
  }, [step]);

  function saveDraft() {
    try {
      localStorage.setItem(draftKey(trader.id), JSON.stringify({ ...d, savedAt: Date.now() }));
      setStatus('Draft saved on this device only. No seat was joined.');
    } catch {
      setStatus('Couldn’t save: local storage is unavailable in this browser.');
    }
  }

  function review() {
    if (!valid) return;
    setFrozen({
      frozenAt: Date.now(),
      terms: {
        perTradeUsd: amount, tradeCount: count, durationDays: d.durationDays, mode: d.mode,
        breakupUsd: breakup, safetyNetBps: 0,
        profitShareBps: DEFAULT_TERMS.profitShareBps, liquidateOnBreakup: false,
      },
    });
    setAck(false);
    setStatus('');
    setStep('review');
  }

  function editTerms() {
    setFrozen(null);
    setStep('edit');
  }

  const back = step === 'edit' ? onClose : step === 'review' ? editTerms : () => setStep('review');
  const title = step === 'edit' ? 'Your Copy Pass' : step === 'review' ? 'Review your Copy Pass' : 'Join your seat';

  return (
    <div className="ps">
      <header className="ps-top">
        <button type="button" className="ps-round" onClick={back}
          aria-label={step === 'edit' ? 'Close pass setup' : 'Back'}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d={step === 'edit' ? 'M6 6l12 12M18 6 6 18' : 'M15 5l-7 7 7 7'} /></svg>
        </button>
        <span className="ps-brand"><img onError={portraitFallback} src="/assets/mark.svg" alt="" width={20} height={20} />swipr</span>
        <ol className="ps-progress" aria-label="Pass setup steps">
          {(['edit', 'review', 'wallet'] as Step[]).map((s, i) => (
            <li key={s} aria-current={s === step ? 'step' : undefined}><span className="ps-sr">Step {i + 1}</span></li>
          ))}
        </ol>
      </header>

      <div className="ps-person">
        {!trader.avatar
          ? <span className="ps-avatar ps-monogram" aria-hidden="true">{trader.name.slice(0, 2).toLowerCase()}</span>
          : <img onError={portraitFallback} className="ps-avatar" src={trader.avatar} alt={`${trader.name}, profile photo`} />}
        <div>
          <b>{trader.name}</b>
          <small>{trader.ens && `${trader.ens} · `}{trader.kind === 'agent' ? `${trader.owner ? shortWallet(trader.owner) : 'Owner'}’s agent` : `${trader.style} style`}</small>
        </div>
        <span className="ps-pill ps-pill-preview">Registered profile · history unverified</span>
      </div>

      <div className="ps-main">
        <h1 ref={headingRef} tabIndex={-1} className="ps-title">{title}</h1>

        {step === 'edit' && (
          <form className="ps-form" onSubmit={(e) => { e.preventDefault(); review(); }} noValidate>
            <p className="ps-lede">Set your limits with {first}. Nothing is saved until you review, and no money moves on this page.</p>
            <dl className="ps-panel"><Row label="Per copied trade">$5 USDC</Row></dl>
            <Stepper id="ps-count" label="Number of trades" suffix="trades" value={d.count} min={1} max={20}
              hint="1–20 copies before the pass stops entering."
              error={count === null ? 'Enter a whole number from 1 to 20.' : null} onChange={(v) => set('count', v)} />
            <div className="ps-cap" aria-live="polite">
              <span>Entry budget for this pass</span>
              <strong>{cap !== null ? usd(cap) : '—'}</strong>
              <small>{cap !== null ? `${usd(amount!)} × ${count} · counts partial fills, never resets` : 'Fix the fields above'}</small>
            </div>
            <Choice legend="Pass length" name="ps-dur" value={d.durationDays}
              options={DURATIONS.map((n) => ({ value: n, label: n === 1 ? '1 day' : `${n} days` }))}
              onChange={(v) => set('durationDays', v)} />
            <p className="ps-hint ps-hint-tight">Requested duration: {d.durationDays} {d.durationDays === 1 ? 'day' : 'days'} from joining.</p>
            <Choice legend="How you copy" name="ps-mode" value={d.mode} wide onChange={(v) => set('mode', v)}
              options={[
                { value: 'tap', label: 'Tap to copy', sub: 'Default · you approve each new trade before entry' },
                { value: 'auto', label: 'Auto-copy', sub: 'Requires separate trading permissions' },
              ]} />
            {d.mode === 'auto' && (
              <p className="ps-note ps-note-warn">After joining, enable automatic entries with a bounded wallet permission in Matches. Exits remain separately reviewed.</p>
            )}
            <div className="ps-actions">
              <button type="submit" className="ps-primary" disabled={!valid}>Review Copy Pass<span aria-hidden="true">→</span></button>
              <button type="button" className="ps-secondary" onClick={saveDraft}>Save local draft</button>
            </div>
          </form>
        )}

        {step === 'review' && frozen && (() => {
          const t = frozen.terms;
              return (
            <section className="ps-review" aria-describedby="ps-frozen">
              <p id="ps-frozen" className="ps-hint">Terms frozen at {when(frozen.frozenAt)} · edit to change</p>
              <div className="ps-hero">
                <span className="ps-hero-amt">{usd(t.perTradeUsd)}</span>
                <span>per copied trade · {t.tradeCount} {t.tradeCount === 1 ? 'trade' : 'trades'} · {t.mode === 'tap' ? 'tap to copy' : 'auto-copy'}</span>
              </div>
              <dl className="ps-panel">
                <Row label="Requested budget">{usd(t.perTradeUsd * t.tradeCount)}</Row>
                <Row label="Pass length">{t.durationDays} {t.durationDays === 1 ? 'day' : 'days'} from joining</Row>
              </dl>

              <p>Joining saves your chosen limits and takes an available seat automatically. Trading permissions and orders are separate.</p>

              <label className="ps-check">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                <span>I’m ready to join with these limits</span>
              </label>
              <div className="ps-actions">
                <button type="button" className="ps-primary" disabled={!ack} onClick={() => setStep('wallet')}>Continue<span aria-hidden="true">→</span></button>
                <button type="button" className="ps-secondary" onClick={editTerms}>Edit terms</button>
              </div>
            </section>
          );
        })()}

        {step === 'wallet' && (
          <section className="ps-wallet">
            <h2 className="ps-h2">{sent ? 'You’re in' : `Join ${first}`}</h2>
            <p>{sent ? 'Your Copy Pass is saved under Matches.' : 'Take an available seat. No trader approval is needed.'}</p>
            {!sent && session.authenticated && <fieldset className="ps-fieldset"><legend className="ps-label">Choose your seat</legend>
              <div className="ps-segmented">{(['public', 'private'] as const).map(kind => <label className="ps-option" key={kind}>
                <input type="radio" name="seat-type" checked={seatType === kind} onChange={() => setSeatType(kind)} disabled={!pool || (kind === 'private' && !pool.invited)} />
                <span className="ps-option-body"><b>{kind === 'public' ? 'Public seat' : 'Private seat'}</b><small>{pool ? (kind === 'public' ? `${pool.publicSeats - pool.publicUsed} available` : pool.invited ? `${pool.privateSeats - pool.privateUsed} available · invited` : 'Invitation required') : 'Loading seats…'}</small></span>
              </label>)}</div></fieldset>}
            <div className="ps-actions">
              {sent ? <button type="button" className="ps-primary" onClick={onClose}>Done</button>
                : !session.authenticated ? <button type="button" className="ps-primary" onClick={session.login}>Sign in to continue</button>
                : <button type="button" className="ps-primary" disabled={busy || !frozen || !pool || (seatType === 'public' ? pool.publicUsed >= pool.publicSeats : !pool.invited || pool.privateUsed >= pool.privateSeats)} onClick={async () => {
                  if (!frozen) return;
                  setBusy(true); setStatus('Joining your seat…');
                  try { await joinSeat(session, trader.id, frozen.terms, seatType); setSent(true); setStatus(''); }
                  catch (e) { setStatus(e instanceof Error ? e.message : 'Your seat could not be saved.'); }
                  finally { setBusy(false); }
                }}>{busy ? 'Joining…' : 'Join seat'}</button>}
              {!sent && <button type="button" className="ps-secondary" disabled={busy} onClick={editTerms}>Edit terms</button>}
            </div>
          </section>
        )}
        <p className="ps-status" role="status" aria-live="polite">{status}</p>
      </div>
    </div>
  );
}
