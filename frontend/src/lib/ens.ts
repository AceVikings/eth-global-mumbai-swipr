import type {Session} from '../auth/Session';
import type {EnsProof} from '../contracts/ens';
import {apiBase} from './bots';
class EnsRequestError extends Error{constructor(readonly status:number,message:string){super(message);}}
export async function ensRequest<T>(session:Session|null,path:string,input?:Record<string,unknown>,signal?:AbortSignal):Promise<T>{
 const token=session?await session.getAccessToken():null;
 const r=await fetch(`${apiBase}/api/ens/${path}`,{method:input?'POST':'GET',signal,cache:'no-store',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},...(input?{body:JSON.stringify({...input,wallet:session?.address})}:{})});
 const data=await r.json();if(!r.ok)throw new EnsRequestError(r.status,data.error?.message||'ENS request failed.');return data;
}
export const getEnsProof=(profileId:string,name?:string,signal?:AbortSignal)=>ensRequest<EnsProof>(null,`verify?profileId=${encodeURIComponent(profileId)}${name?`&name=${encodeURIComponent(name)}`:''}`,undefined,signal);
const pause=(ms:number,signal:AbortSignal)=>new Promise<void>((resolve,reject)=>{
 if(signal.aborted)return reject(new Error('ENS setup stopped.'));
 const stop=()=>{clearTimeout(timer);reject(new Error('ENS setup stopped.'));};
 const timer=setTimeout(()=>{signal.removeEventListener('abort',stop);resolve();},ms);signal.addEventListener('abort',stop,{once:true});
});
let queue=Promise.resolve();
/** Swipr's registrar pays and signs. The trader wallet is never asked for an ENS transaction. */
export function sponsorEns(session:Session,profileId:string,signal:AbortSignal){
 const task=async()=>{
  for(let attempt=0;attempt<16;attempt++){
   if(signal.aborted)throw new Error('ENS setup stopped.');
   try{
    const result=await ensRequest<{name:string;state:'pending'|'ready'}>(session,'onboard',{profileId},signal);
    if(result.state==='ready')return result;
   }catch(e){
    if(signal.aborted)throw e;
    if(e instanceof EnsRequestError&&(e.status===400||e.status===401||e.status===403||e.message.includes('revoked')||e.message.includes('not ready')))throw e;
    if(attempt===15)throw e;
   }
   await pause(2000,signal);
  }
  throw new Error('ENS setup is still confirming. It will resume next time.');
 };
 const result=queue.then(task);queue=result.then(()=>{},()=>{});return result;
}
