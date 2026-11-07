import { useEffect, useRef, useState, type ReactNode } from 'react';
import { formatUnits } from 'viem';
import { useSession } from '../auth/Session';
import type { SeatPass } from '../contracts/seats';
import { tradeRequest, sendReviewedTrade, type TradeQuote } from '../lib/trading';
import { settlePass, saveSettlementReceipt, type PassState, type SettlementQuote } from '../lib/pass-management';
import { enableAutomation, readAutomation, stopAutomation } from '../lib/automation';
const usd=(v:string)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(v)/1e6);
export default function PassPositions({seat,children}:{seat:SeatPass;children?:ReactNode}){
 const session=useSession(),[state,setState]=useState<PassState|null>(null),[quote,setQuote]=useState<TradeQuote|null>(null),[settlement,setSettlement]=useState<SettlementQuote|null>(null);
 const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState(''),[exits,setExits]=useState(false),[uncertain,setUncertain]=useState(false);
 const abort=useRef(new AbortController()),generation=useRef(0);
 const refresh=async()=>{
  const g=generation.current;
  try{const next=await tradeRequest<PassState>(session,`pass?wallet=${session.address}&seatId=${seat.id}`,undefined,abort.current.signal);if(g===generation.current)setState(next);}
  catch(e){if(g===generation.current&&!abort.current.signal.aborted)setError(e instanceof Error?e.message:'Pass is unavailable.');}
 };
 useEffect(()=>{
  const current=++generation.current;abort.current=new AbortController();setState(null);setQuote(null);setSettlement(null);setUncertain(false);setExits(false);setError('');setBusy(false);setMessage('');
  void refresh();void readAutomation(session).then(s=>{if(current===generation.current)setExits(s.grants.some(g=>g.seatId===seat.id&&g.active&&g.exitLimits));}).catch(()=>{});
  const timer=setInterval(()=>{if(document.visibilityState==='visible')void refresh();},30000);
  return()=>{generation.current++;abort.current.abort();clearInterval(timer);};
 },[session.address,seat.id]);
 const act=async(fn:()=>Promise<void>)=>{const g=generation.current;setBusy(true);setError('');try{await fn();}catch(e){if(g===generation.current)setError(e instanceof Error?e.message:'Request failed.');}finally{if(g===generation.current)setBusy(false);}};
 const review=(asset:'WETH'|'cbBTC',reason:string)=>void act(async()=>{setQuote(await tradeRequest<TradeQuote>(session,'pass-exit',{seatId:seat.id,asset,reason},abort.current.signal));setSettlement(null);await refresh();});
 return <details className="pass-positions"><summary>Your connection <span aria-hidden="true">⌄</span></summary>
  {!state?<p>{error||'Loading verified holdings…'}</p>:<>
   <dl><div><dt>Pass P&amp;L</dt><dd>{usd(state.pnl)}</dd></div><div><dt>Best P&amp;L</dt><dd>{usd(state.highWater)}</dd></div><div><dt>Realized</dt><dd>{usd(state.realized)}</dd></div></dl>
   {state.paused&&<p>{state.ended?'This pass has ended.':'Drawdown reached. New entries are paused.'} You can close positions or keep them for the trader’s next exit.</p>}
   {state.pending&&<p>Waiting for outstanding orders to finish. Review resting orders in Trade.</p>}
   {state.positions.map(p=><div className="pass-position" key={p.asset}><p>{formatUnits(BigInt(p.units),p.asset==='WETH'?18:8)} {p.asset} · {usd(p.value)}</p>
    <div className="match-actions"><button className="secondary-button" disabled={busy||state.pending||uncertain} onClick={()=>review(p.asset,'cashout')}>Review cashout</button>
    {state.plans.filter(plan=>plan.asset===p.asset&&plan.reason!=='cashout').map(plan=><button key={plan.reason} className="primary-button" disabled={busy||state.pending||uncertain} onClick={()=>review(p.asset,plan.reason)}>{plan.reason==='stop'?'Review protective exit':'Review trader’s exit'}</button>)}</div>
   </div>)}
   {!!state.positions.length&&<div className="match-actions"><button className="secondary-button" disabled={busy} onClick={()=>void act(async()=>{if(exits){await stopAutomation(session,seat.id);setExits(false);}else{await enableAutomation(session,seat,setMessage,true);setExits(true);}setMessage('');})}>{exits?'Stop automatic exits':'Enable exits for current holdings'}</button></div>}
   {!exits&&!!state.positions.length&&<small>Automatic exits need a separate wallet permission. Proceeds return to your wallet.</small>}
   {!state.positions.length&&!state.pending&&!state.settlement&&<button className="secondary-button" disabled={busy} onClick={()=>void act(async()=>{setSettlement(await tradeRequest<SettlementQuote>(session,'pass-settlement',{seatId:seat.id}));setQuote(null);})}>Review final settlement</button>}
   {state.settlement&&<p>Settled · trader share {usd(state.settlement.amount)} {state.settlement.txHash&&<a href={`https://basescan.org/tx/${state.settlement.txHash}`} target="_blank" rel="noreferrer">View payment</a>} <button className="text-button" disabled={busy} onClick={()=>void act(async()=>{await saveSettlementReceipt(session,seat.id,{...state.settlement,trader:seat.traderOwner});setMessage('Receipt saved to your wallet-owned data.');})}>Save receipt</button></p>}
  </>}
  {quote&&<section className="trade-review"><h3>Review exit</h3><p>Sell {quote.intent.qty} {quote.intent.asset} for USDC.{quote.intent.sharedPrice?` Minimum price $${quote.intent.sharedPrice}.`:' Market order with 1% maximum slippage.'} Swipr fee: 0.1%, included.</p>
   <button className="primary-button" disabled={busy||uncertain} onClick={()=>void act(async()=>{
    try{const result=await sendReviewedTrade(session,quote,setMessage,abort.current.signal);setQuote(null);setMessage(`Exit submitted: ${result.orderId}. Waiting for confirmed fills.`);await refresh();}
    catch(e){if(e instanceof Error&&'uncertain' in e&&e.uncertain)setUncertain(true);throw e;}
   })}>Approve and sign exit</button></section>}
  {settlement&&<section className="trade-review"><h3>Trader share: {usd(settlement.amount)}</h3><p>5% of positive realized pass profit. Totals below $0.05 are waived.</p><button className="primary-button" disabled={busy} onClick={()=>void act(async()=>{await settlePass(session,settlement,setMessage);setSettlement(null);setMessage('Pass settled.');await refresh();})}>{settlement.amount==='0'?'Finish with no payment':'Pay trader and finish'}</button></section>}
  {children}
  {message&&<p role="status">{message}</p>}{state&&error&&<p role="alert">{error}</p>}
 </details>;
}
