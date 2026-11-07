import{useEffect,useState}from'react';
import{useSession}from'../auth/Session';
import type{SeatPass}from'../contracts/seats';
import{readAutomation,enableAutomation,stopAutomation}from'../lib/automation';
export default function AutomationControl({seat}:{seat:SeatPass}){
 const session=useSession(),[active,setActive]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 useEffect(()=>{let alive=true;const load=()=>void readAutomation(session).then(r=>{if(alive)setActive(r.grants.some(g=>g.seatId===seat.id&&g.active&&(!g.exitLimits||g.entries===true)));}).catch(()=>{});load();const timer=setInterval(load,30000);return()=>{alive=false;clearInterval(timer);};},[session.address,seat.id]);
 return <div className="match-automation"><p>{active?'Automatic entries enabled':'Automatic entries need your wallet permission. Exits are reviewed separately.'}</p>
  <button className="secondary-button" disabled={busy} onClick={async()=>{setBusy(true);setMessage('');try{if(active){await stopAutomation(session,seat.id);setActive(false);}else{await enableAutomation(session,seat,setMessage);setActive(true);}setMessage('');}catch(e){setMessage(e instanceof Error?e.message:'Permission could not be confirmed.');}finally{setBusy(false);}}}>{busy?'Waiting for wallet…':active?'Stop automatic copying':'Enable automatic copying'}</button>
  {!active&&<button className="secondary-button" disabled={busy} onClick={async()=>{setBusy(true);try{await stopAutomation(session,seat.id);setMessage('Copy permission stopped.');}catch(e){setMessage(e instanceof Error?e.message:'Could not stop permission.');}finally{setBusy(false);}}}>Stop copy permission</button>}
  {message&&<p role="status">{message}</p>}
 </div>;
}
