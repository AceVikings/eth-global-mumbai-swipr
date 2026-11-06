import { useEffect, useRef, useState } from 'react';
import { formatUnits } from 'viem';
import { useSession, WalletBalance } from '../auth/Session';
import type { BotProfile } from '../contracts/bots';
import type { SeatPass } from '../contracts/seats';
import { getBots } from '../lib/bots';
import { readSeats } from '../lib/wallet-seats';
import { sendReviewedTrade, tradeRequest, TradeError, type TradeQuote, type TradeStatus } from '../lib/trading';
import Dropdown from './Dropdown';
import '../trades.css';
export default function TradeDesk({ initialProfileId = '' }: { initialProfileId?: string }) {
  const session = useSession();
  const [profiles, setProfiles] = useState<BotProfile[]>([]), [seats, setSeats] = useState<SeatPass[]>([]);
  const [profileId, setProfileId] = useState(''), [asset, setAsset] = useState<'WETH' | 'cbBTC'>('WETH');
  const [price, setPrice] = useState(''), [source, setSource] = useState(''), [lookup, setLookup] = useState('');
  const [quote, setQuote] = useState<TradeQuote | null>(null), [order, setOrder] = useState<TradeStatus | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState(''), [uncertain, setUncertain] = useState(false);
  const controller = useRef(new AbortController());
  const statusPending = useRef(false), statusVersion = useRef(0);
  const wallet = session.address?.toLowerCase();
  const selected = profiles.find(p => p.id === profileId);
  const own = selected?.owner.toLowerCase() === wallet;
  const seat = seats.find(p => p.traderId === profileId && p.status === 'joined' && p.owner.toLowerCase() === wallet);
  useEffect(() => {
    controller.current.abort(); controller.current = new AbortController();
    const signal = controller.current.signal;
    setProfiles([]); setSeats([]); setQuote(null); setOrder(null); setError(''); setMessage(''); setUncertain(false); setBusy(false); setLoading(true);
    if (!session.authenticated || !session.address) { setLoading(false); return; }
    void Promise.all([getBots(signal), readSeats(session)]).then(([bots, directory]) => {
      if (signal.aborted) return;
      const active = bots.profiles.filter(p => p.status === 'active' && (p.owner.toLowerCase() === wallet || directory.passes.some(s => s.traderId === p.id && s.owner.toLowerCase() === wallet && s.status === 'joined')));
      setProfiles(active); setSeats(directory.passes); setProfileId(active.find(p => p.id === initialProfileId)?.id || active[0]?.id || '');
    }).catch(e => { if (!signal.aborted) setError(e instanceof Error ? e.message : 'Could not load trading accounts.'); })
      .finally(() => { if (!signal.aborted) setLoading(false); });
    return () => controller.current.abort();
  }, [wallet, session.authenticated, initialProfileId]);
  useEffect(() => { setQuote(null); setError(''); setSource(''); setPrice(''); if (selected) setAsset(selected.assets[0]); }, [profileId]);
  const checkStatus = async (orderId: string, signal: AbortSignal) => {
    const version = ++statusVersion.current;
    statusPending.current = true;
    try {
      const result = await tradeRequest<TradeStatus>(session, `status?wallet=${session.address}&orderId=${encodeURIComponent(orderId)}`, undefined, signal);
      if (!signal.aborted && version === statusVersion.current) {
        setOrder(result); setError('');
        if (result.fills.length || ['FILLED', 'CANCELLED', 'REJECTED', 'TERMINATED'].includes(result.status.replace(/^ORDER_STATUS_/, '').toUpperCase())) setMessage('');
      }
      return result;
    } finally { if (version === statusVersion.current) statusPending.current = false; }
  };
  useEffect(() => {
    if (!order) return;
    const status = order.status.replace(/^ORDER_STATUS_/, '').toUpperCase();
    if (order.unverifiedFills === 0 && (['CANCELLED', 'REJECTED', 'TERMINATED'].includes(status) || (status === 'FILLED' && order.fills.length > 0))) return;
    const signal = controller.current.signal;
    const refresh = () => {
      if (document.visibilityState !== 'visible' || statusPending.current) return;
      void checkStatus(order.orderId, signal).catch(e => { if (!signal.aborted) setError(e instanceof Error ? e.message : 'Could not refresh the order.'); });
    };
    const timer = window.setInterval(refresh, 5000);
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [order?.orderId, order?.status, order?.fills.length, order?.unverifiedFills, wallet]);
  const stopIfDeclined = (e: unknown) => {
    const text = e instanceof Error ? e.message : 'The wallet request did not complete.';
    setError(text); if (e instanceof TradeError && e.uncertain) setUncertain(true);
  };
  if (!session.authenticated) return <section className="content-page"><h1>Trade<span>.</span></h1><p>Sign in to trade from your wallet.</p><button className="primary-button" onClick={session.login}>Sign in</button></section>;
  return <section className="trade-desk content-page"><header><div><h1>Trade<span>.</span></h1><p className="page-lead">Review a 5 USDC limit buy on Base.</p></div><WalletBalance /></header>
    <p className="trade-wallet">Your Base wallet <code>{session.address}</code></p>
    {loading ? <p role="status">Loading your profiles and seats…</p> : !profiles.length ? <p>Create a trader profile or join a seat to place a trade.</p> : <form onSubmit={async e => {
      e.preventDefault(); setBusy(true); setError(''); setMessage('Getting a live quote…'); setQuote(null);
      const signal = controller.current.signal;
      try {
        const result = await tradeRequest<TradeQuote>(session, 'quote', { profileId, asset, qty: '5', sharedPrice: price,
          ...(!own ? { seatId: seat?.id, sourceOrderId: source.trim() } : {}) }, signal);
        if (!signal.aborted) { setQuote(result); setMessage(''); }
      } catch (e) { if (!signal.aborted) { stopIfDeclined(e); setMessage(''); } }
      finally { if (!signal.aborted) setBusy(false); }
    }}>
      <fieldset disabled={busy || uncertain || !!order}><legend className="sr-only">Trade details</legend>
        <label>Trading as<Dropdown label="Trading profile" value={profileId} options={profiles.map(p => [p.id, `${p.name}${p.owner.toLowerCase() === wallet ? ' · Trader' : ' · Copier'}`])} onChange={setProfileId} /></label>
        <label>Buy<Dropdown label="Buy asset" value={asset} options={(selected?.assets || ['WETH']).map(a => [a, a])} onChange={value => { setAsset(value); setQuote(null); }} /></label>
        <label>Spend<input readOnly value="5.00 USDC" /></label>
        {own ? <label>Maximum price per {asset} (USD)<input required inputMode="decimal" autoComplete="off" placeholder="Enter your limit price" value={price} onChange={e => { setPrice(e.target.value); setQuote(null); }} /></label>
          : <label>Trader’s confirmed order ID<input required autoComplete="off" value={source} onChange={e => { setSource(e.target.value); setQuote(null); }} placeholder="Order ID from your trader" /><small>Your copy uses the trader’s original limit price and remaining window.</small></label>}
        <button className="primary-button" type="submit">{busy ? 'Preparing…' : 'Review quote'}</button>
      </fieldset>
    </form>}
    {quote && !order && <section className="trade-review"><h2>Review your buy</h2><dl>
      <div><dt>Wallet</dt><dd><code>{quote.intent.funder}</code></dd></div><div><dt>Spend</dt><dd>{quote.intent.qty} USDC</dd></div>
      <div><dt>Buy</dt><dd>{quote.intent.asset}</dd></div><div><dt>Protection</dt><dd>No stop-loss or automatic exit</dd></div><div><dt>Maximum price</dt><dd>${quote.intent.sharedPrice}</dd></div>
      <div><dt>Estimated trading fee</dt><dd>{quote.estimatedFeeNotional ? `$${quote.estimatedFeeNotional}` : 'Unavailable'}</dd></div>
      <div><dt>Expires</dt><dd>{new Date(quote.expiresAt * 1000).toLocaleTimeString()}</dd></div>
    </dl><details><summary>Wallet permissions</summary><p>Approval: exactly 5 USDC.</p><p>Settlement contract <code>{String(quote.typedData.domain.verifyingContract)}</code></p><p>Execution vault <code>{String(quote.typedData.message.vault)}</code></p></details><p>This uses real funds. Your wallet will review the token approval and order signature.</p>
      <button type="button" className="primary-button" disabled={busy || uncertain} onClick={async () => {
        setBusy(true); setError(''); const signal = controller.current.signal;
        try {
          const result = await sendReviewedTrade(session, quote, text => { if (!signal.aborted) setMessage(text); }, signal);
          if (signal.aborted) return;
          setOrder({ orderId: result.orderId, status: 'Submitted', fills: [], unverifiedFills: 0 }); setLookup(result.orderId);
          setQuote(null); setMessage('Order submitted. Waiting for confirmed fills.');
          await checkStatus(result.orderId, signal);
        } catch (e) { if (!signal.aborted) stopIfDeclined(e); }
        finally { if (!signal.aborted) setBusy(false); }
      }}>{busy ? 'Waiting for wallet…' : 'Approve and sign 5 USDC buy'}</button>
    </section>}
    {message && <p role="status">{message}</p>}{error && <p className="trade-error" role="alert">{error}</p>}
    {order && <section className="trade-review"><h2>Your order</h2><p><code>{order.orderId}</code></p><p>{order.status.replace(/^ORDER_STATUS_/, '').toLowerCase().replaceAll('_', ' ')}</p>
      {!order.fills.length && <p>No verified fill yet. Submission does not mean the trade filled.</p>}
      {order.fills.map(fill => <p key={fill.txHash}>Bought {formatUnits(BigInt(fill.assetUnits), fill.asset === 'cbBTC' ? 8 : 18)} {fill.asset} · {(Number(fill.usdcMicros) / 1e6).toFixed(2)} USDC · <a target="_blank" rel="noreferrer" href={`https://basescan.org/tx/${fill.txHash}`}>Verified on Base</a></p>)}
      {order.unverifiedFills > 0 && <p>Some provider fills are still waiting for receipt verification.</p>}
    </section>}
    <form className="trade-lookup" onSubmit={async e => {
      e.preventDefault(); setError(''); setBusy(true); const signal = controller.current.signal;
      try { await checkStatus(lookup.trim(), signal); } catch (e) { if (!signal.aborted) stopIfDeclined(e); }
      finally { if (!signal.aborted) setBusy(false); }
    }}><h2>Check an existing order</h2><label>Order ID<input value={lookup} onChange={e => setLookup(e.target.value)} required autoComplete="off" /></label>
      <button className="secondary-button" disabled={busy}>Check order</button></form>
  </section>;
}
