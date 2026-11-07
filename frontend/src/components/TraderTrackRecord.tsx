import { useEffect, useState } from 'react';
import { formatPct, formatUsd, getLeaderboard, same } from '../lib/social';
import type { LeaderboardRow } from '../lib/social';

type RecordState = { status: 'loading' | 'empty' | 'error' } | { status: 'ready'; row: LeaderboardRow };

export default function TraderTrackRecord({ wallet }: { wallet?: string }) {
  const [record, setRecord] = useState<RecordState>({ status: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        if (!wallet) { setRecord({ status: 'empty' }); return; }
        const result = await getLeaderboard({ role: 'trader', sort: 'absolute', scope: 'everyone', wallet: null }, null, controller.signal);
        if (controller.signal.aborted) return;
        const row = result.rows.find(r => same(r.address, wallet));
        setRecord(result.state !== 'ready' ? { status: 'error' } : row ? { status: 'ready', row } : { status: 'empty' });
      } catch {
        if (!controller.signal.aborted) setRecord({ status: 'error' });
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(load, 60_000);
      }
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [wallet]);

  return <div className="dsc-net-return" aria-live="polite">
    {record.status === 'ready' ? <>
      <span>Trader wallet · realized net profit</span>
      <strong>{formatUsd(record.row.netProfitUsd)}</strong>
      <div className="dsc-period"><span>Return <b>{formatPct(record.row.returnPct)}</b></span><span>Closed positions <b>{record.row.closedPositions}</b></span></div>
      <p>Wallet-wide results after execution fees; open positions excluded.</p>
    </> : <p>{record.status === 'loading' ? 'Loading verified results…' : record.status === 'error' ? 'Track record could not be loaded.' : 'No verified closed positions yet.'}</p>}
    {wallet && <a className="text-button" href={`https://basescan.org/address/${wallet}`} target="_blank" rel="noreferrer">View wallet activity ↗</a>}
  </div>;
}
