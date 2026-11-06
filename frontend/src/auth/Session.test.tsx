import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {createElement} from 'react';
import {renderToString} from 'react-dom/server';
vi.mock('@privy-io/react-auth',()=>({PrivyProvider:()=>createElement('div',{'data-privy':'mounted'})}));
let session:typeof import('./Session');
beforeAll(async()=>{vi.stubEnv('VITE_PRIVY_APP_ID','offline-shell-test-app');session=await import('./Session');});
afterAll(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
it('renders the cold offline shell without a fake signed-in wallet or remote provider',()=>{
 vi.stubGlobal('navigator',{onLine:false});
 function State(){const s=session.useSession();return createElement('span',null,JSON.stringify({configured:s.configured,ready:s.ready,authenticated:s.authenticated,address:s.address}));}
 const html=renderToString(createElement(session.SessionProvider,null,createElement(State)));
 expect(html).toContain('&quot;configured&quot;:true');expect(html).toContain('&quot;ready&quot;:false');
 expect(html).toContain('&quot;authenticated&quot;:false');expect(html).toContain('&quot;address&quot;:null');expect(html).not.toContain('data-privy');
});
it('uses the real provider path when the app starts online',()=>{
 vi.stubGlobal('navigator',{onLine:true});
 expect(renderToString(createElement(session.SessionProvider,null,createElement('span',null,'shell')))).toContain('data-privy="mounted"');
});
