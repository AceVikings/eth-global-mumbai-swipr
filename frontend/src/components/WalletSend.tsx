import {useEffect,useRef,useState} from 'react';
import {useSession} from '../auth/Session';
import {prepareUsdcTransfer,sendUsdc,WalletTransferError} from '../lib/wallet-transfer';
export default function WalletSend(){
 const session=useSession(),[recipient,setRecipient]=useState(''),[amount,setAmount]=useState(''),[review,setReview]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[hash,setHash]=useState(''),[locked,setLocked]=useState(false);
 const controller=useRef(new AbortController());
 useEffect(()=>{controller.current=new AbortController();setReview(false);setBusy(false);setMessage('');setHash('');setLocked(false);return()=>controller.current.abort();},[session.address]);
 return <details className="wallet-send"><summary>Send USDC</summary><form onSubmit={async e=>{
  e.preventDefault();setMessage('');
  if(!review){try{prepareUsdcTransfer(session.address!,recipient,amount);setReview(true);}catch(e){setMessage(e instanceof Error?e.message:'Check the transfer details.');}return;}
  setBusy(true);const signal=controller.current.signal;
  try{const tx=await sendUsdc(session,recipient,amount,text=>{if(!signal.aborted){setMessage(text);if(text.startsWith('Transfer submitted.'))setLocked(true);}},signal);if(!signal.aborted){setHash(tx);setMessage('Transfer confirmed on Base.');}}
  catch(e){if(e instanceof WalletTransferError&&e.uncertain)setLocked(true);if(!signal.aborted)setMessage(e instanceof Error?e.message:'Transfer could not be confirmed. Check your wallet before retrying.');}
  finally{if(!signal.aborted)setBusy(false);}
 }}>
 <label>Recipient wallet<input required disabled={busy||review} value={recipient} onChange={e=>setRecipient(e.target.value)} autoComplete="off" /></label>
 <label>Amount (USDC)<input required disabled={busy||review} value={amount} onChange={e=>setAmount(e.target.value)} inputMode="decimal" /></label>
 {review&&<p>Send {amount} USDC on Base to <code>{recipient}</code>. Your wallet will ask you to confirm.</p>}
 <div className="session-delete"><button className="session-btn" disabled={busy||locked||!!hash}>{busy?'Waiting for wallet…':review?'Confirm transfer':'Review transfer'}</button>{review&&!busy&&!hash&&!locked&&<button type="button" className="session-btn session-btn-quiet" onClick={()=>setReview(false)}>Edit</button>}</div>
 {message&&<p role="status">{message}</p>}{hash&&<a href={`https://basescan.org/tx/${hash}`} target="_blank" rel="noreferrer">View transaction</a>}
 </form></details>;
}
