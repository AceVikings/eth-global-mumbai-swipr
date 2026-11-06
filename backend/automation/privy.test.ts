import {generateKeyPairSync,verify} from 'node:crypto';
import {expect,it,vi} from 'vitest';
import {createPrivyControl} from './privy';
import {canonical} from './policy';
it('signs the exact method, URL, body and Privy headers with the isolated P256 key',async()=>{
 const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 const key=pair.privateKey.export({format:'der',type:'pkcs8'}).toString('base64');
 const fetcher=vi.fn(async()=>new Response('{}'));
 const control=createPrivyControl({appId:'test-app',appSecret:'private-test',authorizationKey:key,fetcher:fetcher as typeof fetch});
 const body={method:'eth_signTypedData_v4',params:{typed_data:{message:{amount:'5'}}}};
 await control.request('/wallets/wallet123456/rpc',body,'quote-1',true);
 const [url,init]=fetcher.mock.calls[0] as unknown as [string,RequestInit];
 const headers=init.headers as Record<string,string>;
 const signedHeaders=Object.fromEntries(Object.entries(headers).filter(([k])=>k.startsWith('privy-')&&k!=='privy-authorization-signature'));
 expect(verify('sha256',Buffer.from(canonical({version:1,method:'POST',url,body,headers:signedHeaders})),pair.publicKey,Buffer.from(headers['privy-authorization-signature'],'base64'))).toBe(true);
 expect(signedHeaders['privy-idempotency-key']).toBe('quote-1');
 expect(Number(signedHeaders['privy-request-expiry'])).toBeGreaterThan(Date.now());
 expect(init.redirect).toBe('error');expect(control.publicKey).toBe(pair.publicKey.export({format:'der',type:'spki'}).toString('base64'));
});
it('fails closed without an authorization key or on a refused provider request',async()=>{
 const fetcher=vi.fn(async()=>new Response('{}',{status:403}));
 const control=createPrivyControl({appId:'app',appSecret:'private-test',fetcher:fetcher as typeof fetch});
 await expect(control.request('/wallets/wallet123456/rpc',{},'id',true)).rejects.toThrow('unavailable');expect(fetcher).not.toHaveBeenCalled();
 await expect(control.request('/policies/policy123456')).rejects.toMatchObject({status:403,code:'permissions_unavailable'});
 await expect(control.request('/wallets/../users')).rejects.toThrow('Invalid Privy resource');
});
