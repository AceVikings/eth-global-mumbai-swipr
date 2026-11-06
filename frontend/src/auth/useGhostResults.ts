import { useEffect, useState } from 'react';
import type { Session } from './Session';
import type { Ghost } from '../contracts/types';
import { apiBase } from '../lib/bots';
export type GhostResult = { traderId: string; state: 'ready' | 'unavailable'; buys?: number; closedTrades?: number; openTrades?: number; realizedPnlUsd?: string };
export function useGhostResults(session: Session, ghosts: Ghost[]) {
  const [results, setResults] = useState<GhostResult[]>([]);
  const ghostKey = ghosts.map(g => `${g.traderId}:${g.startedAt}`).join(',');
  useEffect(() => {
    const abort = new AbortController(); let pending = false;
    setResults([]);
    if (!session.address || !session.authenticated || !ghosts.length) return;
    const load = async () => {
      if (pending) return; pending = true;
      try {
        const token = await session.getAccessToken();
        if (!token || abort.signal.aborted) return;
        const response = await fetch(`${apiBase}/api/ghosts/results?wallet=${session.address}`, { headers: { authorization: `Bearer ${token}` }, signal: abort.signal, cache: 'no-store' });
        if (!response.ok) throw Error('unavailable');
        const data = await response.json();
        if (!Array.isArray(data.results)) throw Error('unavailable');
        if (!abort.signal.aborted) setResults(data.results);
      } catch { if (!abort.signal.aborted) setResults(ghosts.map(g => ({ traderId: g.traderId, state: 'unavailable' }))); }
      finally { pending = false; }
    };
    void load();
    const refresh = () => { if (document.visibilityState === 'visible') void load(); };
    const timer = window.setInterval(refresh, 30000); window.addEventListener('focus', refresh);
    return () => { abort.abort(); window.clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [session.address, session.authenticated, ghostKey]);
  return results;
}
