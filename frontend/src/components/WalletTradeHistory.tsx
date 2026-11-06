import {useEffect,useRef,useState} from 'react';
import {formatUnits} from 'viem';
import {useSession} from '../auth/Session';
import {tradeRequest,type TradeHistory} from '../lib/trading';
export default function WalletTradeHistory(){
 const session=useSession(),[history,setHistory]=useState<TradeHistory|null>(null),[error,setError]=useState('');
 const reload=useRef(()=>{});
 useEffect(()=>{
  const abort=new AbortController();let pending=false;
  setHistory(null);setError('');
  const load=async()=>{
   if(pending||!session.address)return;pending=true;
   try{const result=await tradeRequest<TradeHistory>(session,`history?wallet=${session.address}`,undefined,abort.signal);
    if(!abort.signal.aborted){setHistory(result);setError('');}}
   catch(e){if(!abort.signal.aborted)setError(e instanceof Error?e.message:'Order history is unavailable.');}
   finally{pending=false;}
  };
  reload.current=()=>void load();void load();
  const refresh=()=>{if(document.visibilityState==='visible')void load();};
  const timer=setInterval(refresh,30000);window.addEventListener('focus',refresh);
  return()=>{abort.abort();clearInterval(timer);window.removeEventListener('focus',refresh);};
 },[session.address]);
 return <section className="trade-history"><h2>Recent wallet orders</h2>
  {error&&<p role="alert">{error} <button className="text-button" onClick={()=>reload.current()}>Try again</button></p>}
  {!history&&!error&&<p role="status">Loading recent orders…</p>}
  {history?.orders.length===0&&<p>No orders in this wallet yet.</p>}
  {history?.orders.map(order=><article className="trade-review" key={order.orderId}>
   <p><code>{order.orderId}</code></p><p>{order.status.replace(/^ORDER_STATUS_/,'').toLowerCase().replaceAll('_',' ')}</p>
   {order.fills.length===0&&<p>No verified fill yet.</p>}
   {order.fills.map(fill=><p key={fill.txHash}>{fill.side==='buy'?'Bought':'Sold'} {formatUnits(BigInt(fill.assetUnits),fill.asset==='cbBTC'?8:18)} {fill.asset} · {formatUnits(BigInt(fill.usdcMicros),6)} USDC · <a target="_blank" rel="noreferrer" href={`https://basescan.org/tx/${fill.txHash}`}>Verified on Base</a></p>)}
   {order.unverifiedFills>0&&<p>Some fills are waiting for receipt verification.</p>}
  </article>)}
  {history?.hasMore&&<p>Showing the latest 20 wallet orders.</p>}
 </section>;
}
