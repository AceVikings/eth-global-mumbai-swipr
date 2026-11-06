import {createPrivateKey,createPublicKey,sign} from 'node:crypto';
import {canonical} from './policy';
import {ApiError} from '../auth';
export function createPrivyControl(options:{appId:string;appSecret:string;authorizationKey?:string;fetcher?:typeof fetch}) {
 const fetcher=options.fetcher??fetch;
 const authKey=options.authorizationKey?createPrivateKey({key:Buffer.from(options.authorizationKey.replace(/^wallet-auth:/,''),'base64'),format:'der',type:'pkcs8'}):null;
 const publicKey=authKey?createPublicKey(authKey).export({format:'der',type:'spki'}).toString('base64'):null;
 const request=async(path:string,body?:unknown,idempotency?:string,authorized=false)=>{
  if(!/^\/(?:policies|wallets|users|key_quorums)(?:\/[a-zA-Z0-9:%_-]+)*(?:\/rpc)?$/.test(path))throw Error('Invalid Privy resource.');
  const url='https://api.privy.io/v1'+path,method=body===undefined?'GET':'POST';
  const privyHeaders:Record<string,string>={'privy-app-id':options.appId,...(idempotency?{'privy-idempotency-key':idempotency}:{})};
  const headers={...privyHeaders,authorization:`Basic ${Buffer.from(`${options.appId}:${options.appSecret}`).toString('base64')}`,'content-type':'application/json'} as Record<string,string>;
  if(authorized){
   if(!authKey)throw Error('Automatic signer is unavailable.');
   privyHeaders['privy-request-expiry']=String(Date.now()+30000);headers['privy-request-expiry']=privyHeaders['privy-request-expiry'];
   headers['privy-authorization-signature']=sign('sha256',Buffer.from(canonical({version:1,method,url,body,headers:privyHeaders})),authKey).toString('base64');
  }
  let response:Response;
  try{response=await fetcher(url,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(12000)});}
  catch{throw new ApiError(503,'permissions_unavailable','Wallet permissions could not be confirmed.');}
  if(!response.ok)throw new ApiError(response.status===403?403:503,'permissions_unavailable','Wallet permissions could not be confirmed.');
  return response.json() as Promise<any>;
 };
 return {request,publicKey};
}
