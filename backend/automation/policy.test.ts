import {expect,it} from 'vitest';
import {copyPolicy,canonical} from './policy';
import {DEFAULT_TERMS} from '../contracts/types';
import type{SeatPass}from'../contracts/seats';
const seat={id:`0x${'11'.repeat(32)}`,owner:`0x${'22'.repeat(20)}`,budgetVersion:1,expiresAt:1800000000000,terms:{...DEFAULT_TERMS,mode:'auto'}} as SeatPass;
it('permits only bounded Flash typed-data entries and excludes transfers, approvals and exports',()=>{
 const p=copyPolicy(seat,`0x${'33'.repeat(20)}`);expect(p.rules.map(r=>r.method)).toEqual(['eth_signTypedData_v4']);
 const conditions=p.rules[0].conditions;
 for(const field of ['chainId','verifyingContract','swapper','recipient','fromToken','toToken','fromAmount','deadline','current_unix_timestamp'])expect(conditions.some(c=>c.field===field)).toBe(true);
 expect(conditions.find(c=>c.field==='recipient')?.value).toBe(seat.owner);
 expect(conditions.find(c=>c.field==='fromAmount')?.value).toBe('10000000');
 expect(JSON.stringify(p)).not.toContain('eth_sendTransaction');
});
it('does not manufacture protected execution or accept legacy passes',()=>{
 expect(()=>copyPolicy({...seat,budgetVersion:undefined},`0x${'33'.repeat(20)}`)).toThrow();
 expect(()=>copyPolicy({...seat,terms:{...seat.terms,safetyNetBps:500}},`0x${'33'.repeat(20)}`)).toThrow();
});
it('canonicalizes nested JSON consistently for Privy request signatures',()=>{
 expect(canonical({z:1,a:{b:'x',a:[true,null]}})).toBe('{"a":{"a":[true,null],"b":"x"},"z":1}');
 expect(()=>canonical({bad:undefined})).toThrow();
});
