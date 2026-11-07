import {expect,it,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import EnsProfile,{EnsIdentity} from './EnsProfile';
vi.mock('../auth/Session',()=>({useSession:()=>({address:'0x123'})}));
it('shows the owner bot identity outside the management disclosure',()=>{
 const html=renderToStaticMarkup(<EnsProfile profile={{id:'profile',ensName:'bot.swipr.eth'} as any}/>);
 expect(html.indexOf('bot.swipr.eth')).toBeLessThan(html.indexOf('<details'));
 expect(html).toContain('Manage ENS records');
});
it('renders a compact name link without the detailed records panel',()=>{
 const html=renderToStaticMarkup(<EnsIdentity compact profileId="profile" name="bot.swipr.eth"/>);
 expect(html).toContain('https://sepolia.app.ens.domains/bot.swipr.eth');
 expect(html).toContain('ENS identity: bot.swipr.eth');
 expect(html).not.toContain('<details');
 expect(html).not.toContain('verified');
});
