import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DEFAULT_TERMS, type Mode, type Terms, type Trader } from '../contracts/types';
import '../pass-setup.css';

type Props = { trader: Trader; onClose: () => void; initialPerTradeUsd?: number };
type Step = 'edit' | 'review' | 'wallet';
type Draft = {
  amount: string; count: string; breakup: string; durationDays: Terms['durationDays'];
  safetyNetBps: number; mode: Mode; liquidateOnBreakup: boolean;
};
type Frozen = { terms: Terms; frozenAt: number };

const DAY = 86_400_000;
const DURATIONS = [1, 7, 30] as const;
const SAFETY_NETS = [300, 500, 800];
const draftKey = (id: string) => `swipr.passDraft.v1.${id}`;

const parseInt_ = (s: string, lo: number, hi: number) =>
  /^\d+$/.test(s.trim()) && +s >= lo && +s <= hi ? +s : null;
const clampInt = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));
const usd = (n: number) => `$${n.toLocaleString('en-US')}`;
const when = (ms: number) =>
  new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(ms);

function freshDraft(initialPerTradeUsd?: number): Draft {
  const amount = initialPerTradeUsd == null || !Number.isFinite(initialPerTradeUsd)
    ? DEFAULT_TERMS.perTradeUsd : clampInt(initialPerTradeUsd, 5, 50);
  return {
    amount: String(amount), count: String(DEFAULT_TERMS.tradeCount),
    breakup: String(DEFAULT_TERMS.breakupUsd), durationDays: DEFAULT_TERMS.durationDays,
    safetyNetBps: DEFAULT_TERMS.safetyNetBps, mode: 'tap', liquidateOnBreakup: false,
  };
}

function loadDraft(traderId: string): { draft: Draft; savedAt: number } | null {
  try {
    const raw = localStorage.getItem(draftKey(traderId));
    if (!raw) return null;
    const d = JSON.parse(raw) as Draft & { savedAt: number };
    if (!d || typeof d !== 'object' || !Number.isSafeInteger(d.savedAt) || d.savedAt < 0 || d.savedAt > Date.now() + 300_000 || !DURATIONS.includes(d.durationDays) || !SAFETY_NETS.includes(d.safetyNetBps)) return null;
    return {
      savedAt: d.savedAt,
      draft: {
        amount: String(d.amount), count: String(d.count), breakup: String(d.breakup),
        durationDays: d.durationDays, safetyNetBps: d.safetyNetBps,
        mode: d.mode === 'auto' ? 'auto' : 'tap', liquidateOnBreakup: d.liquidateOnBreakup === true,
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

export default function PassSetup({ trader, onClose, initialPerTradeUsd }: Props) {
  const [stored] = useState(() => loadDraft(trader.id));
  const [d, setD] = useState<Draft>(() => stored?.draft ?? freshDraft(initialPerTradeUsd));
  const [step, setStep] = useState<Step>('edit');
  const [frozen, setFrozen] = useState<Frozen | null>(null);
  const [ack, setAck] = useState(false);
  const [status, setStatus] = useState(stored ? `Loaded your local draft from ${when(stored.savedAt)}.` : '');
  const headingRef = useRef<HTMLHeadingElement>(null);
  const first = trader.name.split(' ')[0];
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((p) => ({ ...p, [k]: v }));

  const amount = parseInt_(d.amount, 5, 50);
  const count = parseInt_(d.count, 1, 20);
  const cap = amount && count ? amount * count : null;
  const breakupMax = cap ?? 1000;
  const breakup = parseInt_(d.breakup, 1, breakupMax);
  const valid = amount !== null && count !== null && breakup !== null;

  useEffect(() => {
    headingRef.current?.focus();
    window.scrollTo({ top: 0 });
  }, [step]);

  function saveDraft() {
    try {
      localStorage.setItem(draftKey(trader.id), JSON.stringify({ ...d, savedAt: Date.now() }));
      setStatus('Draft saved on this device only. No request was sent.');
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
        breakupUsd: breakup, safetyNetBps: d.safetyNetBps,
        profitShareBps: DEFAULT_TERMS.profitShareBps, liquidateOnBreakup: d.liquidateOnBreakup,
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
  const title = step === 'edit' ? 'Your Copy Pass' : step === 'review' ? 'Review before requesting' : 'Activation unavailable';

  return (
    <div className="ps">
      <header className="ps-top">
        <button type="button" className="ps-round" onClick={back}
          aria-label={step === 'edit' ? 'Close pass setup' : 'Back'}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d={step === 'edit' ? 'M6 6l12 12M18 6 6 18' : 'M15 5l-7 7 7 7'} /></svg>
        </button>
        <span className="ps-brand"><img src="/assets/mark.svg" alt="" width={20} height={20} />swipr</span>
        <ol className="ps-progress" aria-label="Pass setup steps">
          {(['edit', 'review', 'wallet'] as Step[]).map((s, i) => (
            <li key={s} aria-current={s === step ? 'step' : undefined}><span className="ps-sr">Step {i + 1}</span></li>
          ))}
        </ol>
      </header>

      <div className="ps-person">
        {!trader.avatar
          ? <span className="ps-avatar ps-monogram" aria-hidden="true">{trader.name.slice(0, 2).toLowerCase()}</span>
          : <img className="ps-avatar" src={trader.avatar} alt={`${trader.name}, profile photo`} />}
        <div>
          <b>{trader.name}</b>
          <small>{trader.ens && `${trader.ens} · `}{trader.kind === 'agent' ? `${trader.owner ?? 'Owner'}’s agent` : `${trader.style} style`}</small>
        </div>
        <span className="ps-pill ps-pill-preview">Registered profile · history unverified</span>
      </div>

      <div className="ps-main">
        <h1 ref={headingRef} tabIndex={-1} className="ps-title">{title}</h1>

        {step === 'edit' && (
          <form className="ps-form" onSubmit={(e) => { e.preventDefault(); review(); }} noValidate>
            <p className="ps-lede">Set your limits with {first}. Nothing is requested until you review, and no money moves on this page.</p>
            <Stepper id="ps-amount" label="Per copied trade" big prefix="$" value={d.amount} min={5} max={50}
              hint="Whole dollars, $5–$50 of USDC per copy."
              error={amount === null ? 'Enter a whole number from 5 to 50.' : null} onChange={(v) => set('amount', v)} />
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
            <p className="ps-hint ps-hint-tight">New entries stop after {d.durationDays} {d.durationDays === 1 ? 'day' : 'days'}. Exit protection runs 7 days longer.</p>
            <Stepper id="ps-breakup" label="Breakup threshold" prefix="−$" value={d.breakup} min={1} max={breakupMax}
              hint={`Pause new entries if the pass falls this far below its best marked P&L. Not a guaranteed loss limit.`}
              error={breakup === null ? `Enter a whole number from 1 to ${breakupMax}.` : null} onChange={(v) => set('breakup', v)} />
            <label className="ps-check">
              <input type="checkbox" checked={d.liquidateOnBreakup} onChange={(e) => set('liquidateOnBreakup', e.target.checked)} />
              <span>Also sell my copied holdings if the threshold is hit<small>Off by default. Without this, positions stay open and still exit with {first}.</small></span>
            </label>
            <Choice legend="Safety-net stop per copy" name="ps-net" value={d.safetyNetBps}
              options={SAFETY_NETS.map((b) => ({ value: b, label: `−${b / 100}%` }))}
              onChange={(v) => set('safetyNetBps', v)} />
            <p className="ps-hint ps-hint-tight">Used when {first}’s own stop is missing or wider. A tighter trigger can exit earlier. Actual fill timing and price can differ.</p>
            <div className="ps-fixed">
              <span>Profit share to {first}</span><b>{DEFAULT_TERMS.profitShareBps / 100}% · fixed</b>
            </div>
            <Choice legend="How you copy" name="ps-mode" value={d.mode} wide onChange={(v) => set('mode', v)}
              options={[
                { value: 'tap', label: 'Tap to copy', sub: 'Default · you approve each new trade before entry' },
                { value: 'auto', label: 'Auto-copy', sub: 'Optional · entries signed for you within these limits' },
              ]} />
            {d.mode === 'auto' && (
              <p className="ps-note ps-note-warn">Auto-copy needs a verified policy signer. It isn’t verified in this build, so an auto pass can’t activate yet.</p>
            )}
            <div className="ps-actions">
              <button type="submit" className="ps-primary" disabled={!valid}>Review Copy Pass<span aria-hidden="true">→</span></button>
              <button type="button" className="ps-secondary" onClick={saveDraft}>Save local draft</button>
            </div>
          </form>
        )}

        {step === 'review' && frozen && (() => {
          const t = frozen.terms;
          const entryEnd = frozen.frozenAt + t.durationDays * DAY;
          return (
            <section className="ps-review" aria-describedby="ps-frozen">
              <p id="ps-frozen" className="ps-pill ps-pill-frozen">Terms frozen at {when(frozen.frozenAt)} · edit to change</p>
              <div className="ps-hero">
                <span className="ps-hero-amt">{usd(t.perTradeUsd)}</span>
                <span>per copied trade · {t.tradeCount} {t.tradeCount === 1 ? 'trade' : 'trades'} · {t.mode === 'tap' ? 'tap to copy' : 'auto-copy'}</span>
              </div>
              <dl className="ps-panel">
                <Row label="Entry budget (pass ledger)">{usd(t.perTradeUsd * t.tradeCount)}</Row>
                <Row label="USDC wallet allowance">Separate approval · amount and spender shown by your wallet</Row>
                <Row label="New entries end">{t.durationDays} {t.durationDays === 1 ? 'day' : 'days'} after activation{' '}
                  <small>(≈ {when(entryEnd)} if activated now)</small></Row>
                <Row label="Exit protection ends">Entry end + 7 days <small>(≈ {when(entryEnd + 7 * DAY)})</small></Row>
                <Row label="Breakup threshold">−{usd(t.breakupUsd)} from best · {t.liquidateOnBreakup ? 'then sell holdings' : 'pause only'}</Row>
                <Row label="Safety-net stop">−{t.safetyNetBps / 100}% per copy</Row>
                <Row label="Profit share">{t.profitShareBps / 100}% of new realized net profit</Row>
                <Row label="Round-trip cost quote"><span className="ps-unavail">Unavailable</span></Row>
                <Row label="Downside estimate"><span className="ps-unavail">Unavailable</span></Row>
              </dl>

              <h2 className="ps-h2">Read before you continue</h2>
              <ul className="ps-points">
                <li><b>Budget vs. allowance.</b> The {usd(t.perTradeUsd * t.tradeCount)} entry budget is tracked per pass and includes partial fills. Your USDC allowance is a separate wallet approval that may differ; changing it never resets this pass’s ledger.</li>
                <li><b>Two end dates.</b> New entries stop at pass expiry. Stops and shared exits keep covering open copies for 7 more days; after that, renew protection or manage the assets yourself.</li>
                <li><b>The threshold isn’t a loss cap.</b> It pauses new entries at −{usd(t.breakupUsd)} from the pass’s best marked P&L. Slippage, price gaps and timing can make losses larger.</li>
                <li><b>Profit share.</b> {t.profitShareBps / 100}% applies only to realized net profit above what you’ve already settled with {first}. That baseline carries across renewals. It is charged only at settlement, never on unrealized gains, and amounts under $0.05 are waived.</li>
                <li><b>Actual signer scope.</b> The exit signer’s rules allow selling <em>any</em> WETH or cbBTC in your wallet to USDC, not only units copied from {first}. Swipr’s engine sells only attributed units, bounded by your balance, but that is software, not an onchain limit.{t.mode === 'auto' && ' Auto-copy adds a USDC entry rule capped per trade.'}</li>
                <li><b>Shared exits aren’t identical.</b> Exits are submitted together with {first}’s. Fills can differ, partially fail or arrive late, and you may need to exit manually.</li>
                <li><b>No live quote yet.</b> Costs and the downside estimate need a live Flash quote, which isn’t connected. They’ll be shown before any signature.</li>
              </ul>

              <label className="ps-check">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                <span>I’ve read these terms and the actual permission scope</span>
              </label>
              <div className="ps-actions">
                <button type="button" className="ps-primary" disabled={!ack} onClick={() => setStep('wallet')}>Continue to wallet<span aria-hidden="true">→</span></button>
                <button type="button" className="ps-secondary" onClick={editTerms}>Edit terms</button>
              </div>
            </section>
          );
        })()}

        {step === 'wallet' && (
          <section className="ps-wallet">
            <div className="ps-note">
              <b>Copy Pass activation is unavailable.</b> Swipr hasn’t sent a seat request, minted a pass name or asked for any approval. Nothing is pending and no funds have moved.
            </div>
            <h2 className="ps-h2">What activation will involve</h2>
            <ol className="ps-steps">
              <li><b>Sign in with Privy</b><small>Creates your own embedded wallet on Base.</small></li>
              <li><b>Seat request with these frozen terms</b><small>{first} accepts or waitlists you. Pending shows as pending.</small></li>
              <li><b>Match mints your pass name</b><small>Only after acceptance.</small></li>
              <li><b>Separate permission review</b><small>Live quote, exact allowance, spenders, signer scope and expiry.</small></li>
              <li><b>You sign, then the pass activates</b><small>Only confirmed onchain state counts as active.</small></li>
            </ol>
            <div className="ps-actions">
              <button type="button" className="ps-primary" onClick={saveDraft}>Save terms as local draft</button>
              <button type="button" className="ps-secondary" onClick={onClose}>Back to {first}</button>
            </div>
          </section>
        )}
        <p className="ps-status" role="status" aria-live="polite">{status}</p>
      </div>
    </div>
  );
}
