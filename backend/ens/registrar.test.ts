import {expect,it} from 'vitest';
import {traderLabel} from './registrar';
it('assigns one stable subname per Arkiv profile independently of display name',()=>{
 const label=traderLabel('0x'+'12'.repeat(32));expect(label).toMatch(/^trader-[0-9a-f]{16}$/);
 expect(traderLabel('0x'+'12'.repeat(32))).toBe(label);expect(traderLabel('different-profile')).not.toBe(label);
});
