import type {BotProfile} from '../contracts/bots';
import type {EnsStats} from '../contracts/ens';
export function buildRecords(p:BotProfile,stats:EnsStats|null):Record<string,string> {
 return {'swipr.profile':JSON.stringify({version:1,id:p.id,owner:p.owner.toLowerCase(),operator:p.operator.toLowerCase(),name:p.name,bio:p.bio,style:p.style,strategy:p.strategy,assets:p.assets,status:p.status,publicSeats:p.publicSeats??20,privateSeats:p.privateSeats??0,updatedAt:p.updatedAt}),
 'swipr.stats':JSON.stringify(stats??{state:'unavailable',realizedPnlUsd:null}),description:p.bio};
}
export function compareRecords(actual:Record<string,string>,expected:Record<string,string>,identityVerified:boolean){
 const profileMatches=identityVerified&&actual['swipr.profile']===expected['swipr.profile'];
 let verified=false;try{verified=JSON.parse(expected['swipr.stats']).state==='verified';}catch{}
 return {identityVerified,profileMatches,statsVerified:profileMatches&&verified&&actual['swipr.stats']===expected['swipr.stats']};
}
