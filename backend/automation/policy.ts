import { FLASH_DOMAIN, FLASH_DOMAIN_TYPES, FLASH_ORDER_TYPES, TOKENS } from '../providers/flash';
import type { SeatPass } from '../contracts/seats';
/** No transaction, transfer, export, 7702 or arbitrary message permission. Approvals remain user-owned. */
export function copyPolicy(seat: SeatPass, vault: string) {
  if(!/^0x[0-9a-f]{40}$/i.test(vault))throw Error('A verified Flash vault is required.');
  if(seat.terms.mode!=='auto'||seat.budgetVersion!==1||seat.terms.safetyNetBps||seat.terms.liquidateOnBreakup)throw Error('This pass needs unsupported exit permissions.');
  const typed_data={types:{EIP712Domain:FLASH_DOMAIN_TYPES,FlashOrder:FLASH_ORDER_TYPES},primary_type:'FlashOrder'};
  const msg=(field:string,value:string,operator='eq')=>({field_source:'ethereum_typed_data_message',field,operator,value,typed_data});
  return {version:'1.0',name:`Swipr pass ${seat.id.slice(2,18)}`,chain_type:'ethereum',rules:[{
    name:'Bounded Base copy entries',method:'eth_signTypedData_v4',action:'ALLOW',conditions:[
      {field_source:'system',field:'current_unix_timestamp',operator:'lt',value:String(Math.floor(seat.expiresAt/1000))},
      {field_source:'ethereum_typed_data_domain',field:'chainId',operator:'eq',value:'8453'},
      {field_source:'ethereum_typed_data_domain',field:'verifyingContract',operator:'eq',value:FLASH_DOMAIN.verifyingContract},
      msg('vault',vault),msg('swapper',seat.owner),msg('recipient',seat.owner),msg('fromToken',TOKENS.USDC.address),
      {...msg('toToken',''),operator:'in',value:[TOKENS.WETH.address,TOKENS.cbBTC.address]},
      msg('fromAmount',String(seat.terms.perTradeUsd*1e6),'lte'),msg('fromAmount','0','gt'),
      msg('deadline',String(Math.floor(seat.expiresAt/1000)),'lte'),
    ],
  }]};
}
export const canonical=(value:unknown):string=>{
 if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k])).join(',')+'}';
 throw Error('Invalid canonical JSON value.');
};
