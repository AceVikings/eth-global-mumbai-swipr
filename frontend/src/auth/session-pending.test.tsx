import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
let sdkReady=false;
vi.mock('@privy-io/react-auth',()=>({
 PrivyProvider:({children}:any)=>children,
 usePrivy:()=>({ready:sdkReady,authenticated:false,user:null,getAccessToken:async()=>null}),
 useWallets:()=>({ready:true,wallets:[]}),useLogin:()=>({login:()=>{}}),useLogout:()=>({logout:async()=>{}}),
 useExportWallet:()=>({exportWallet:async()=>{}}),useSendTransaction:()=>({sendTransaction:async()=>{}}),
 useSigners:()=>({addSigners:async()=>{}}),useUpdateWallet:()=>({updateWallet:async()=>{}}),
}));
let auth:typeof import('./Session');
beforeAll(async()=>{vi.stubEnv('VITE_PRIVY_APP_ID','session-test-app');vi.stubGlobal('navigator',{onLine:true});auth=await import('./Session');});
afterAll(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
const screen=()=>renderToString(createElement(auth.SessionProvider,null,createElement(auth.SignInButton,{className:'sidebar'}),createElement(auth.SessionPending)));
it('shows the same connecting state in the sidebar and page while Privy initializes',()=>{
 sdkReady=false;const html=screen();expect(html.match(/Connecting…/g)).toHaveLength(2);expect(html).not.toContain('>Sign in<');expect(html).not.toContain('Loading…');
});
it('enables both login entry points only when the shared session is ready',()=>{
 sdkReady=true;const html=screen();expect(html.match(/>Sign in</g)).toHaveLength(2);expect(html).not.toContain('disabled');
});
