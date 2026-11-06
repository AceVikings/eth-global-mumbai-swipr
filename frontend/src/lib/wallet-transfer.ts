import {encodeFunctionData,erc20Abi,getAddress,parseUnits,type Hex} from 'viem';
import type {Session} from '../auth/Session';
const USDC='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;
export class WalletTransferError extends Error { constructor(message:string,readonly uncertain=false){super(message);} }
export function prepareUsdcTransfer(from:string,recipient:string,amount:string){
 const owner=getAddress(from),to=getAddress(recipient.trim());
 if(to===owner||/^0x0{40}$/i.test(to))throw Error('Choose another valid wallet.');
 if(!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(amount))throw Error('Enter a USDC amount with up to six decimals.');
 const units=parseUnits(amount,6);if(units<=0n||units>5000000n)throw Error('Send between 0 and 5 USDC per transfer.');
 return {from:owner,to:USDC,value:'0x0' as Hex,chainId:'0x2105' as Hex,data:encodeFunctionData({abi:erc20Abi,functionName:'transfer',args:[to,units]})};
}
export async function sendUsdc(session:Session,recipient:string,amount:string,progress:(text:string)=>void,signal:AbortSignal){
 const owner=session.address;if(!owner)throw Error('Sign in first.');
 const plan=prepareUsdcTransfer(owner,recipient,amount),{address,provider}=await session.getBaseWallet();
 if(address!==plan.from||signal.aborted)throw Error('Your account changed.');
 if(BigInt(await provider.request({method:'eth_chainId'}))!==8453n)throw Error('Switch to Base.');
 const raw=await provider.request({method:'eth_call',params:[{to:USDC,data:encodeFunctionData({abi:erc20Abi,functionName:'balanceOf',args:[address]})},'latest']});
 if(BigInt(raw as Hex)<parseUnits(amount,6))throw Error('Insufficient USDC balance.');
 if(signal.aborted)throw Error('Transfer stopped.');
 progress('Review this USDC transfer in your wallet.');
 let hash:unknown;
 try{hash=await provider.request({method:'eth_sendTransaction',params:[plan]});}
 catch(e){if((e as {code?:number})?.code===4001)throw Error('The transfer was declined.');throw new WalletTransferError('The transfer may have been submitted. Check your wallet before retrying.',true);}
 if(typeof hash!=='string'||!/^0x[0-9a-f]{64}$/i.test(hash))throw new WalletTransferError('No transaction hash returned. Check your wallet before retrying.',true);
 progress('Transfer submitted. Waiting for confirmation…');
 for(let i=0;i<60;i++){
  if(signal.aborted)throw Error('Transfer was submitted. Check your wallet for its status.');
  const receipt=await provider.request({method:'eth_getTransactionReceipt',params:[hash as Hex]}) as {status:string;blockNumber:string}|null;
  if(receipt?.status==='0x0')throw Error('The transfer failed.');
  if(receipt?.status==='0x1'&&receipt.blockNumber){
   const head=await provider.request({method:'eth_blockNumber'});
   if(BigInt(head as Hex)-BigInt(receipt.blockNumber)>=1n){
    const tx=await provider.request({method:'eth_getTransactionByHash',params:[hash as Hex]}) as {from:string;to:string;input:string;value:string};
    if(tx.from.toLowerCase()!==plan.from.toLowerCase()||tx.to.toLowerCase()!==USDC.toLowerCase()||tx.input!==plan.data||BigInt(tx.value)!==0n)throw Error('The transaction differs from the reviewed transfer.');
    return hash;
   }
  }
  await new Promise(r=>setTimeout(r,2000));
 }
 throw Error(`Transfer remains pending: ${hash}. Check this transaction before retrying.`);
}
