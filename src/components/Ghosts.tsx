import type { Ghost, Trader } from '../../shared/types';
import { isGhostExpired } from '../lib/ghosts';
import '../ghosts.css';

type Props = {
  ghosts: Ghost[];
  traders: Trader[];
  onReal: (t: Trader) => void;
  onRemove: (id: string) => void;
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

function Row({ ghost, trader, now, onReal, onRemove }: {
  ghost: Ghost; trader?: Trader; now: number;
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
            <span className="gh-pill">{expired ? 'Expired' : 'Simulated'}</span>
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
        No trade results yet.
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

export default function Ghosts({ ghosts, traders, onReal, onRemove }: Props) {
  const now = Date.now();
  const byId = new Map(traders.map((t) => [t.id, t]));
  const sorted = [...ghosts].sort((a, b) =>
    Number(isGhostExpired(a, now)) - Number(isGhostExpired(b, now)) || b.startedAt - a.startedAt);
  const active = sorted.filter((g) => !isGhostExpired(g, now)).length;

  return (
    <section className="gh" aria-labelledby="gh-title">
      <header className="gh-header">
        <h1 id="gh-title" className="gh-title">Your ghosts</h1>
        <p className="gh-lede">
          Simulate trades for free. No money moves.
        </p>
      </header>

      {sorted.length === 0 ? (
        <div className="gh-empty">
          <h2 className="gh-empty-title">No ghosts yet</h2>
          <p className="gh-note">Find a trader in Discover and tap Ghost copy. Your simulation stays on this device.</p>
        </div>
      ) : (
        <>
          <p className="gh-count">
            {active} active · {sorted.length - active} expired
          </p>
          <ul className="gh-list">
            {sorted.map((g) => (
              <Row key={g.traderId} ghost={g} trader={byId.get(g.traderId)} now={now}
                onReal={onReal} onRemove={onRemove} />
            ))}
          </ul>
          <p className="gh-note">
            Estimates use the trader’s recorded prices. Real results may differ.
          </p>
        </>
      )}
    </section>
  );
}
