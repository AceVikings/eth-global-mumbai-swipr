import {useEffect,useRef,useState} from 'react';
import {useSession} from '../auth/Session';
import type {BotProfile} from '../contracts/bots';
import {type EnsProof} from '../contracts/ens';
import {getEnsProof,sponsorEns} from '../lib/ens';
import './ens.css';
const reason=(e:unknown)=>e instanceof Error?e.message:'ENS could not be updated.';
const explorer=(name:string)=>`https://sepolia.app.ens.domains/${encodeURIComponent(name)}`;
export function EnsIdentity({profileId,name}:{profileId:string;name?:string}){
 const [proof,setProof]=useState<EnsProof|null>(null),[error,setError]=useState('');
 useEffect(()=>{
  const ctrl=new AbortController();let loading=false;
  const load=async()=>{if(loading)return;loading=true;try{const v=await getEnsProof(profileId,name,ctrl.signal);if(!ctrl.signal.aborted){setProof(v);setError('');}}catch{if(!ctrl.signal.aborted){setProof(null);setError('ENS verification is unavailable.');}}finally{loading=false;}};
  void load();const timer=window.setInterval(()=>{if(document.visibilityState==='visible')void load();},30000);
  window.addEventListener('focus',load);return()=>{ctrl.abort();clearInterval(timer);window.removeEventListener('focus',load);};
 },[profileId,name]);
 if(!proof&&!name)return null;
 const displayed=proof?.name||name||'';
 return <div className="ens-identity"><a href={explorer(displayed)} target="_blank" rel="noreferrer">{displayed}</a>
  <span>{error||(!proof?'Checking ENS…':!proof.identityVerified?'Name does not match the trader wallet.':!proof.profileMatches?'Wallet verified · profile needs updating':!proof.fresh?'Wallet verified · snapshot is stale':proof.statsVerified?'Wallet and recent trade records verified':'Wallet and profile verified · trade stats unavailable')}</span>
  {proof?.identityVerified&&<details><summary>ENS records</summary>{Object.entries(proof.records).map(([key,value])=><div key={key}><b>{key}</b><pre><code>{value||'Not published'}</code></pre></div>)}</details>}
 </div>;
}
export default function EnsProfile({profile}:{profile:BotProfile;onChanged?:()=>void}){
 const session=useSession();const [name,setName]=useState(profile.ensName||'');
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 const ctrl=useRef<AbortController|null>(null);
 const run=()=>{
  ctrl.current?.abort();const abort=new AbortController();ctrl.current=abort;setBusy(true);setError('');
  void sponsorEns(session,profile.id,abort.signal).then(result=>{if(!abort.signal.aborted)setName(result.name);})
   .catch(e=>{if(!abort.signal.aborted)setError(reason(e));})
   .finally(()=>{if(!abort.signal.aborted)setBusy(false);});
 };
 useEffect(()=>{run();const timer=setInterval(run,300000);return()=>{clearInterval(timer);ctrl.current?.abort();};},[profile.id,profile.updatedAt,session.address]);
 return <details className="ens-profile"><summary>ENS identity</summary>
  {name&&<EnsIdentity profileId={profile.id} name={name}/>}
  {busy&&<p role="status">Setting up your trader name…</p>}
  {error&&<p role="status">{error}</p>}
  <div className="bs-row-actions"><button type="button" className="bs-btn bs-btn-quiet" disabled={busy} onClick={run}>{name?'Update records':'Set up trader name'}</button></div>
 </details>;
}
