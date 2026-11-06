import {expect,it} from 'vitest';
import {sponsoredGasLimit,traderLabel} from './registrar';
it('assigns one stable subname per Arkiv profile independently of display name',()=>{
 const label=traderLabel('0x'+'12'.repeat(32));expect(label).toMatch(/^trader-[0-9a-f]{16}$/);
 expect(traderLabel('0x'+'12'.repeat(32))).toBe(label);expect(traderLabel('different-profile')).not.toBe(label);
});

it('allows measured record setup gas while capping buffered gas and ETH cost',()=>{
 expect(sponsoredGasLimit(5444854n,17n)).toBe(6533825n);
 expect(()=>sponsoredGasLimit(7000000n,17n)).toThrow('gas is high');
 expect(()=>sponsoredGasLimit(5444854n,1000000000n)).toThrow('gas is high');
 expect(()=>sponsoredGasLimit(0n,17n)).toThrow('gas is high');
});
