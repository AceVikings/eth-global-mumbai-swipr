import { expect, it } from 'vitest';
import { buildRecords, compareRecords } from './records';
const p = {id:'profile-1',owner:`0x${'12'.repeat(20)}`,operator:`0x${'34'.repeat(20)}`,name:'Trader',bio:'Real strategy',style:'Balanced',strategy:'manual',assets:['WETH'],status:'active',createdAt:'2026-11-01T00:00:00Z',updatedAt:'2026-11-01T00:00:00Z'} as const;
it('publishes unavailable performance as null, never invented zero profit', () => {
 const r=buildRecords(p as any, null);
 expect(JSON.parse(r['swipr.stats'])).toMatchObject({state:'unavailable',realizedPnlUsd:null});
 expect(JSON.parse(r['swipr.profile'])).toMatchObject({id:p.id,owner:p.owner});
});
it('distinguishes identity, profile freshness and independently checked stats', () => {
 const r=buildRecords(p as any,{state:'verified',scope:'latest20Orders',fills:[],realizedPnlUsd:null});
 expect(compareRecords(r,r,true)).toMatchObject({identityVerified:true,profileMatches:true,statsVerified:true});
 expect(compareRecords({...r,'swipr.stats':'{"realizedPnlUsd":"999"}'},r,true).statsVerified).toBe(false);
 expect(compareRecords(r,r,false).statsVerified).toBe(false);
 expect(compareRecords(buildRecords(p as any,null),buildRecords(p as any,null),true).statsVerified).toBe(false);
});

it('publishes a Swarm image reference as part of the verifiable profile', () => {
 const image = `bzz://${'a'.repeat(64)}`;
 const record = buildRecords({...p,image} as any,null);
 expect(JSON.parse(record['swipr.profile']).image).toBe(image);
 expect(compareRecords(record,buildRecords(p as any,null),true).profileMatches).toBe(false);
});
