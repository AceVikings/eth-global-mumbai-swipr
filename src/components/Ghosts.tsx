import type { Ghost, Trader } from '../../shared/types';
import { isGhostExpired } from '../lib/ghosts';
import '../ghosts.css';

type Props = {
  ghosts: Ghost[];
  traders: Trader[];
  onReal: (t: Trader) => void;
  onRemove: (id: string) => void;
  // Fixture profiles stay labeled until verified live data is configured.
  preview?: boolean;
};

const HOUR = 60 * 60 * 1000;

const when = (ms: number) => new Intl.DateTimeFormat(undefined, {
  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
}).format(ms);

const remaining = (ms: number) => {
  const hours = Math.ceil(ms / HOUR);
  if (hours < 24) return hours <= 1 ? 'under 1 hour left' : `${hours} hours left`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day left' : `${days} days left`;
};

const usd = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;

function Avatar({ trader }: { trader?: Trader }) {
  if (trader?.avatar) {
    return <img className="gh-avatar" src={trader.avatar} alt={`Portrait of ${trader.name}`} width={56} height={56} />;
  }
  return <span className="gh-avatar gh-monogram" aria-hidden="true">{trader ? trader.name.slice(0, 1) : '?'}</span>;
}

function Row({ ghost, trader, now, preview, onReal, onRemove }: {
  ghost: Ghost; trader?: Trader; now: number; preview: boolean;
  onReal: Props['onReal']; onRemove: Props['onRemove'];
}) {
  const expired = isGhostExpired(ghost, now);
  const name = trader?.name ?? 'Unknown trader';
  return (
    <li className={`gh-row${expired ? ' gh-row-expired' : ''}`}>
      <div className="gh-row-head">
        <Avatar trader={trader} />
        <div className="gh-who">
          <p className="gh-name">{name}</p>
          <p className="gh-meta">
            {trader ? trader.ens : `Profile ${ghost.traderId} is not loaded`}
            {trader?.kind === 'agent' && trader.owner ? ` · agent by ${trader.owner}` : ''}
          </p>
          <div className="gh-tags">
            <span className="gh-pill">{expired ? 'Expired · history' : 'Ghost · not executed'}</span>
            {preview && trader && <span className="gh-pill gh-pill-quiet">Preview profile</span>}
          </div>
        </div>
      </div>
      <dl className="gh-facts">
        <div><dt>Size</dt><dd>{usd(ghost.perTradeUsd)} / trade</dd></div>
        <div>
          <dt>Started</dt>
          <dd><time dateTime={new Date(ghost.startedAt).toISOString()}>{when(ghost.startedAt)}</time></dd>
        </div>
        <div>
          <dt>{expired ? 'Expired' : 'Expires'}</dt>
          <dd>
            <time dateTime={new Date(ghost.expiresAt).toISOString()}>{when(ghost.expiresAt)}</time>
            {!expired && <span className="gh-left"> · {remaining(ghost.expiresAt - now)}</span>}
          </dd>
        </div>
      </dl>
      <p className="gh-result">
        <span className="gh-dash" aria-hidden="true">—</span>
        Result unavailable. No recorded trades are loaded for this ghost, so no estimate is shown.
      </p>
      <div className="gh-actions">
        {trader && (
          <button type="button" className="gh-btn gh-btn-primary" onClick={() => onReal(trader)}>
            Make {trader.name} real
          </button>
        )}
        <button type="button" className="gh-btn gh-btn-quiet" aria-label={`Remove ghost of ${name}`}
          onClick={() => onRemove(ghost.traderId)}>
          {expired ? 'Remove to restart' : 'Remove'}
        </button>
      </div>
    </li>
  );
}

export default function Ghosts({ ghosts, traders, onReal, onRemove, preview = true }: Props) {
  const now = Date.now();
  const byId = new Map(traders.map((t) => [t.id, t]));
  const sorted = [...ghosts].sort((a, b) =>
    Number(isGhostExpired(a, now)) - Number(isGhostExpired(b, now)) || b.startedAt - a.startedAt);
  const active = sorted.filter((g) => !isGhostExpired(g, now)).length;

  return (
    <section className="gh" aria-labelledby="gh-title">
      <header className="gh-header">
        <span className="gh-pill gh-badge">Simulation · no funds move</span>
        <h1 id="gh-title" className="gh-title">Your ghosts</h1>
        <p className="gh-lede">
          Free, local “what if” copies. Nothing here places an order, holds a seat or moves money.
        </p>
      </header>

      {sorted.length === 0 ? (
        <div className="gh-empty">
          <h2 className="gh-empty-title">No ghosts yet</h2>
          <ol className="gh-steps">
            <li>Open <strong>Discover</strong> from the navigation.</li>
            <li>Swipe right or tap <strong>Ghost copy</strong> on a trader you like.</li>
            <li>Their ghost appears here with its start time, size per trade and 7-day expiry.</li>
          </ol>
          <p className="gh-note">Ghosts are a free simulation saved on this device. No funds move.</p>
        </div>
      ) : (
        <>
          <p className="gh-count">
            {active} active · {sorted.length - active} expired
          </p>
          <ul className="gh-list">
            {sorted.map((g) => (
              <Row key={g.traderId} ghost={g} trader={byId.get(g.traderId)} now={now}
                preview={preview} onReal={onReal} onRemove={onRemove} />
            ))}
          </ul>
          <p className="gh-note">
            Results will come from the trader’s recorded trades since your start time, assuming fills at
            their price. Real fills may differ. Expired ghosts stay as history; remove one to start it again.
          </p>
        </>
      )}
    </section>
  );
}
