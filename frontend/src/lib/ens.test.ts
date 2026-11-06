import {afterEach,expect,it,vi} from 'vitest';
import {sponsorEns} from './ens';
afterEach(()=>vi.unstubAllGlobals());
it('requests a sponsored trader subname without asking the trader wallet to sign',async()=>{
 const fetcher=vi.fn(async(_input:RequestInfo|URL,_init?:RequestInit)=>Response.json({name:'alice.swipr.eth',state:'ready'}));vi.stubGlobal('fetch',fetcher);
 const wallet=vi.fn();const session={address:'0x123',getAccessToken:async()=>'test-token',getBaseWallet:wallet,getArkivWallet:wallet} as any;
 expect(await sponsorEns(session,'profile',new AbortController().signal)).toMatchObject({name:'alice.swipr.eth'});
 expect(wallet).not.toHaveBeenCalled();
 expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toMatchObject({wallet:'0x123',profileId:'profile'});
});
it('does not retry ownership failures or proceed after cancellation',async()=>{
 const fetcher=vi.fn(async()=>Response.json({error:{message:'Only the owner'}},{status:403}));vi.stubGlobal('fetch',fetcher);
 const session={address:'0x123',getAccessToken:async()=>'test-token'} as any;
 await expect(sponsorEns(session,'profile',new AbortController().signal)).rejects.toThrow('owner');expect(fetcher).toHaveBeenCalledOnce();
 const c=new AbortController();c.abort();await expect(sponsorEns(session,'profile',c.signal)).rejects.toThrow('stopped');expect(fetcher).toHaveBeenCalledOnce();
});
