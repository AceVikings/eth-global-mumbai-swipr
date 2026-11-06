import { portraitFallback } from '../lib/profile-images';
import { EnsIdentity } from './EnsProfile';
import { short as shortWallet } from '../lib/bots';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { Trader } from '../contracts/types';
import { Icon } from './Icons';
import '../discover.css';

type Props = {
  traders: Trader[];
  onGhost: (t: Trader) => Promise<boolean>;
  onReal: (t: Trader) => void;
  perTradeUsd: number;
  vibe: string;
};
type Dir = 'left' | 'right';
type Toast = { trader: Trader; index: number };

const LOCK_PX = 8;
const COMMIT_PX = 96;
const FLICK_PX = 24;
const FLICK_SPEED = 0.5; // px per ms
const EXIT_MS = 180;
const TOAST_MS = 5000;

const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const isTyping = (el: EventTarget | null) =>
  el instanceof HTMLElement && !!el.closest('input, textarea, select, [contenteditable="true"]');
const usd = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;

export default function Discover({ traders, onGhost, onReal, perTradeUsd, vibe }: Props) {
  const [saving, setSaving] = useState(false);
  const [index, setIndex] = useState(0);
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [exiting, setExiting] = useState<Dir | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [proofsOpen, setProofsOpen] = useState(false);
  const drag = useRef<{ id: number; x: number; y: number; t: number; axis: 'x' | 'y' | null } | null>(null);
  const proofsOpener = useRef<HTMLElement | null>(null);
  const busy = useRef(false);
  const exitTimer = useRef<number | undefined>(undefined);
  const dragged = useRef(false);

  const trader = traders[index] as Trader | undefined;

  useEffect(() => () => window.clearTimeout(exitTimer.current), []);

  useEffect(() => {
    if (index > traders.length) setIndex(traders.length);
  }, [index, traders.length]);

  useEffect(() => {
    if (!toast || busy.current) return;
    const id = window.setTimeout(() => setToast(null), TOAST_MS);
    return () => window.clearTimeout(id);
  }, [toast]);

  const act = useCallback(async (dir: Dir, t: Trader, i: number) => {
    if (dir === 'right') {
      setExiting(null); setDx(0); setSaving(true);
      const saved = await onGhost(t);
      setSaving(false);
      if (!saved) { busy.current = false; return; }
      setToast(null);
    } else {
      setToast({ trader: t, index: i });
    }
    dragged.current = false;
    setIndex(i + 1);
    setDx(0);
    setExiting(null);
    busy.current = false;
  }, [onGhost]);

  const decide = useCallback((dir: Dir) => {
    if (!trader || busy.current) return;
    busy.current = true;
    if (reducedMotion()) return act(dir, trader, index);
    setExiting(dir);
    exitTimer.current = window.setTimeout(() => act(dir, trader, index), EXIT_MS);
  }, [act, index, trader]);

  const undo = () => {
    if (!toast || busy.current) return;
    setIndex(toast.index);
    setToast(null);
  };

  const openProofs = () => {
    proofsOpener.current = document.activeElement as HTMLElement | null;
    setProofsOpen(true);
  };
  const closeProofs = () => {
    setProofsOpen(false);
    window.setTimeout(() => proofsOpener.current?.focus(), 0);
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (proofsOpen || isTyping(e.target) || e.altKey || e.metaKey || e.ctrlKey) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); decide('left'); }
    if (e.key === 'ArrowRight') { e.preventDefault(); decide('right'); }
  };

  // Direction lock: a vertical start reads the profile natively (touch-action: pan-y);
  // only a horizontal start moves the card and can commit a decision.
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current || busy.current || (e.pointerType === 'mouse' && e.button !== 0)) return;
    dragged.current = false;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), axis: null };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const mx = e.clientX - d.x;
    const my = e.clientY - d.y;
    if (!d.axis) {
      if (Math.hypot(mx, my) < LOCK_PX) return;
      d.axis = Math.abs(mx) > Math.abs(my) ? 'x' : 'y';
      if (d.axis === 'y') return;
      e.currentTarget.setPointerCapture(e.pointerId);
      window.getSelection()?.removeAllRanges();
      dragged.current = true;
      setDragging(true);
    }
    if (d.axis === 'x') setDx(mx);
  };
  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (d.axis !== 'x') return;
    setDragging(false);
    const mx = e.clientX - d.x;
    const speed = Math.abs(mx) / Math.max(1, performance.now() - d.t);
    const commit = e.type === 'pointerup' &&
      (Math.abs(mx) >= COMMIT_PX || (speed > FLICK_SPEED && Math.abs(mx) >= FLICK_PX));
    if (commit) decide(mx > 0 ? 'right' : 'left');
    else setDx(0);
  };
  const onClickCapture = (e: ReactMouseEvent) => {
    if (dragged.current) { e.stopPropagation(); e.preventDefault(); dragged.current = false; }
  };

  const width = 420;
  const shown = exiting ? (exiting === 'right' ? width * 1.4 : -width * 1.4) : dx;
  const rot = Math.max(-8, Math.min(8, (shown / width) * 8));
  const ghostAmt = Math.max(0, Math.min(1, dx / COMMIT_PX));
  const passAmt = Math.max(0, Math.min(1, -dx / COMMIT_PX));
  const cardStyle = reducedMotion()
    ? { opacity: exiting ? 0 : 1 }
    : { transform: `translateX(${shown}px) rotate(${rot}deg)` };

  return (
    <section className={`dsc${trader ? '' : ' is-empty'}`} aria-labelledby="dsc-title">
      <header className="dsc-head">
        <div>
          <h1 id="dsc-title">Meet your next <em>trader.</em></h1>
          <p>Swipe right to ghost-copy for free. No funds move.</p>
        </div>
        <div className="dsc-head-tools">
          <span className="dsc-chip" title="Your deck preferences">{vibe} · {usd(perTradeUsd)}/trade</span>
          <button type="button" className="dsc-help-trigger" popoverTarget="dsc-help" aria-label="How Swipr works" title="How it works">?</button>
        </div>
        <div id="dsc-help" className="dsc-help-popover" popover="auto" role="dialog" aria-labelledby="dsc-help-title">
          <div className="dsc-help-heading"><h2 id="dsc-help-title">How it works</h2><button type="button" className="dsc-close" popoverTarget="dsc-help" popoverTargetAction="hide" aria-label="Close help"><Icon name="x" size={18} /></button></div>
          <ul className="dsc-how">
            <li><span className="dsc-how-i"><Icon name="x" size={18} /></span><div><b>Pass</b><p>Skip a trader. Undo brings them right back.</p></div></li>
            <li><span className="dsc-how-i is-ghost"><Icon name="ghost" size={18} /></span><div><b>Ghost copy</b><p>Try a free simulation at {usd(perTradeUsd)}/trade. No wallet, no order, no funds moved.</p></div></li>
            <li><span className="dsc-how-i"><Icon name="star" size={18} /></span><div><b>Make it real</b><p>Choose a Copy Pass, then review its limits and permissions before signing.</p></div></li>
          </ul>
          <p className="dsc-keys">On a keyboard, focus the deck and use <kbd>←</kbd> to pass or <kbd>→</kbd> to ghost-copy.</p>
        </div>
      </header>

      <div className="dsc-layout">
        <div
          className="dsc-deck"
          tabIndex={trader ? 0 : -1}
          role="region"
          aria-roledescription={trader ? "trader deck" : undefined}
          aria-label={trader ? "Trader deck. Left arrow passes, right arrow ghost-copies." : "Trader availability"}
          onKeyDown={onKeyDown}
        >
          <div className="dsc-stack">
            {trader && index + 1 < traders.length && <div className="dsc-edge dsc-edge-1" aria-hidden="true" />}
            {trader && index + 2 < traders.length && <div className="dsc-edge dsc-edge-2" aria-hidden="true" />}
            {trader ? (
              <div
                key={trader.id + index}
                className={`dsc-card${dragging ? ' is-dragging' : ''}${exiting ? ' is-exiting' : ''}`}
                style={cardStyle}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerEnd}
                onPointerCancel={onPointerEnd}
                onClickCapture={onClickCapture}
              >
                <span className="dsc-stamp dsc-stamp-ghost" style={{ opacity: ghostAmt }} aria-hidden="true">Ghost copy</span>
                <span className="dsc-stamp dsc-stamp-pass" style={{ opacity: passAmt }} aria-hidden="true">Pass</span>
                <div className="dsc-scroll" tabIndex={0} aria-label={`${trader.name}'s profile. Scroll to read.`}>
                  <Portrait trader={trader} />
                  <Profile trader={trader} perTradeUsd={perTradeUsd} onProofs={openProofs} />
                </div>
              </div>
            ) : (
              <div className="dsc-empty">
                <h2>{traders.length ? "That’s everyone for now." : "No traders available."}</h2>
                <p>{traders.length ? "You’ve seen this deck. Check back later or start over." : "Try a different trading style or add your bot."}</p>
                {traders.length > 0 && <button type="button" className="dsc-btn" onClick={() => { setIndex(0); setToast(null); }}>
                  Start over
                </button>}
              </div>
            )}
          </div>

          {trader && <div className="dsc-controls" role="group" aria-label="Decide on this trader">
            <div className="dsc-ctl">
              <button type="button" aria-label={trader ? `Pass on ${trader.name}` : 'Pass'} disabled={!trader || !!exiting || saving} onClick={() => decide('left')}>
                <Icon name="x" />
              </button>
              <span aria-hidden="true">Pass</span>
            </div>
            <div className="dsc-ctl dsc-ctl-ghost">
              <button type="button" aria-label={trader ? `Ghost-copy ${trader.name} for free` : 'Ghost copy'} disabled={!trader || !!exiting || saving} onClick={() => decide('right')}>
                <Icon name="ghost" size={28} />
              </button>
              <span aria-hidden="true">Ghost copy</span>
            </div>
            <div className="dsc-ctl">
              <button type="button" aria-label={trader ? `Make it real: set up a Copy Pass with ${trader.name}` : 'Make it real'} disabled={!trader || !!exiting || saving} onClick={() => trader && onReal(trader)}>
                <Icon name="star" />
              </button>
              <span aria-hidden="true">Make it real</span>
            </div>
          </div>}

          <div className="dsc-toast-slot" aria-live="polite">
            {toast && (
              <div className="dsc-toast dsc-toast-pass">
                <Icon name="x" size={18} />
                <span>Passed on {toast.trader.name}</span>
                <button type="button" disabled={!!exiting || saving} onClick={undo}><Icon name="undo" size={16} />Undo</button>
              </div>
            )}
          </div>
        </div>

        {trader && <aside className="dsc-rail dsc-stats-rail" aria-label={`${trader.name}'s trader stats`}>
          <div className="dsc-rail-heading"><span className="dsc-eyebrow">{trader.name.toUpperCase()}’S TRACK RECORD</span><h2>The person &amp; the numbers.</h2></div>
          <div className="dsc-net-return"><span>Copiers kept, after all fees</span><strong aria-label="Net copier return unavailable">—</strong><p>No verified history connected yet.</p><div className="dsc-period"><span>Period <b>—</b></span><span>Real copies <b>—</b></span></div></div>
          <dl className="dsc-metric-grid">{['Trader P&L', 'Win rate', 'Max drawdown', 'Copy fill rate', 'Sealed trades', 'Outside exits', 'Seats available', 'Profit share'].map(label => <div key={label}><dt>{label}</dt><dd aria-label={`${label} unavailable`}>—</dd></div>)}</dl>
          <div className="dsc-rail-bio"><span className="dsc-eyebrow">THE STRATEGY</span><p>{trader.bio}</p><div className="dsc-markers"><span className="dsc-pill">{trader.style}</span><span className="dsc-pill">{trader.kind === 'agent' ? `${trader.owner ? shortWallet(trader.owner) : 'Owner'}’s agent` : 'Human trader'}</span></div></div>
          <button type="button" className="dsc-btn dsc-btn-quiet dsc-rail-proofs" onClick={openProofs}><Icon name="shield" size={18} />Show proofs<Icon name="chevron" size={16} /></button>
        </aside>}
      </div>

      {proofsOpen && trader && <ProofSheet trader={trader} onClose={closeProofs} />}
    </section>
  );
}

function Portrait({ trader }: { trader: Trader }) {
  const monogram = !trader.avatar;
  return (
    <div className="dsc-photo">
      {monogram ? (
        <div className="dsc-monogram" aria-hidden="true">{trader.name.slice(0, 2)}</div>
      ) : (
        <img onError={portraitFallback} src={trader.avatar} alt={`${trader.name}, profile photo`} draggable={false} />
      )}
      <span className="dsc-preview-tag">{trader.source === 'registered' ? 'Registered bot · unverified history' : 'Registered profile · unverified history'}</span>
      <div className="dsc-photo-info">
        <h2>{trader.name}</h2>
        <p>{trader.ens}</p>
      </div>
      <span className="dsc-hint" aria-hidden="true">Scroll for profile <Icon name="chevron" size={14} /></span>
    </div>
  );
}

function Profile({ trader, perTradeUsd, onProofs }: { trader: Trader; perTradeUsd: number; onProofs: () => void }) {
  return (
    <div className="dsc-profile">
      <section>
        <h3>About</h3>
        <p>{trader.bio}</p>
      </section>
      <section>
        <h3>Net copier return</h3>
        <p className="dsc-unavail">Unavailable</p>
        <p className="dsc-note">No verified execution history is connected for this profile, so we don’t show a return, win rate or drawdown.</p>
        <dl className="dsc-stats">
          <div><dt>Period</dt><dd>— Unavailable</dd></div>
          <div><dt>Sample</dt><dd>— Unavailable</dd></div>
          <div><dt>Max drawdown</dt><dd>— Unavailable</dd></div>
        </dl>
      </section>
      <section>
        <h3>Trader markers</h3>
        <div className="dsc-markers">
          <span className="dsc-pill">{trader.style}</span>
          <span className="dsc-pill">{trader.kind === 'agent' ? `Agent${trader.owner ? ` · owned by ${trader.owner ? shortWallet(trader.owner) : 'Owner'}` : ''}` : 'Human trader'}</span>
          <span className="dsc-pill dsc-pill-ghost">Ghost at {`$${perTradeUsd}`}/trade</span>
          <span className="dsc-pill">Identity not verified</span>
        </div>
      </section>
      <section>
        <button type="button" className="dsc-btn dsc-btn-quiet" onClick={onProofs}>
          <Icon name="shield" size={18} />Show proofs<Icon name="chevron" size={16} />
        </button>
      </section>
    </div>
  );
}

const PROOFS: [string, string][] = [
  ['Sealed trade history (Arkiv)', 'No sealed entities read. Nothing to query yet.'],
  ['Flash orders and receipts', 'No orders or fills recorded for this profile.'],
  ['Archive (Swarm)', 'No archived receipt available.'],
];

function ProofSheet({ trader, onClose }: { trader: Trader; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('button')?.focus();
  }, []);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
    if (e.key !== 'Tab' || !ref.current) return;
    const items = ref.current.querySelectorAll<HTMLElement>('button, [href], [tabindex]:not([tabindex="-1"])');
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  const copy = () => {
    navigator.clipboard?.writeText(trader.ens).then(() => setCopied(true), () => setCopied(false));
  };

  return (
    <div className="dsc-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className="dsc-sheet" role="dialog" aria-modal="true" aria-labelledby="dsc-proofs-title" onKeyDown={onKeyDown}>
        <div className="dsc-sheet-head">
          <h2 id="dsc-proofs-title">{trader.name}’s proofs</h2>
          <button type="button" className="dsc-close" aria-label="Close proofs" onClick={onClose}><Icon name="x" size={20} /></button>
        </div>
        {trader.profileId && <EnsIdentity profileId={trader.profileId} name={trader.ens || undefined} />}
        {trader.ens && <div className="dsc-ens">
          <code>{trader.ens}</code>
          <button type="button" className="dsc-btn dsc-btn-quiet" onClick={copy}>
            {copied && <Icon name="check" size={16} />}{copied ? 'Copied' : 'Copy name'}
          </button>
        </div>}
        <ul className="dsc-proofs">
          {PROOFS.map(([label, detail]) => (
            <li key={label}>
              <b>{label}</b>
              <span className="dsc-unavail-tag">Unavailable</span>
              <p>{detail}</p>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
