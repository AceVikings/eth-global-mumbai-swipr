import { FLASH_DOMAIN, FLASH_DOMAIN_TYPES, FLASH_ORDER_TYPES, TOKENS } from '../providers/flash';
import type { SeatPass } from '../contracts/seats';
/** No transaction, transfer, export, 7702 or arbitrary message permission. Approvals remain user-owned. */
export type ExitLimits = Partial<Record<'WETH'|'cbBTC',string>>;
export const EXIT_GRACE_MS=7*86400000;
export function copyPolicy(seat: SeatPass, vault: string, exits?: ExitLimits, entries = !exits) {
  if(!/^0x[0-9a-f]{40}$/i.test(vault))throw Error('A verified Flash vault is required.');
  if((seat.terms.mode!=='auto'&&!exits)||seat.budgetVersion!==1)throw Error('This pass needs unsupported exit permissions.');
  const typed_data={types:{EIP712Domain:FLASH_DOMAIN_TYPES,FlashOrder:FLASH_ORDER_TYPES},primary_type:'FlashOrder'};
  const msg=(field:string,value:string,operator='eq')=>({field_source:'ethereum_typed_data_message',field,operator,value,typed_data});
  const common = [
    {field_source:'ethereum_typed_data_domain',field:'chainId',operator:'eq',value:'8453'},
    {field_source:'ethereum_typed_data_domain',field:'verifyingContract',operator:'eq',value:FLASH_DOMAIN.verifyingContract},
    msg('vault',vault),msg('swapper',seat.owner),msg('recipient',seat.owner),msg('fromAmount','0','gt'),
  ];
  const rules = seat.terms.mode==='auto' && entries ? [{
    name:'Bounded Base copy entries',method:'eth_signTypedData_v4',action:'ALLOW',conditions:[
      ...common,{field_source:'system',field:'current_unix_timestamp',operator:'lt',value:String(Math.floor(seat.expiresAt/1000))},
      msg('fromToken',TOKENS.USDC.address),{...msg('toToken',''),operator:'in',value:[TOKENS.WETH.address,TOKENS.cbBTC.address]},
      msg('fromAmount',String(seat.terms.perTradeUsd*1e6),'lte'),msg('deadline',String(Math.floor(seat.expiresAt/1000)),'lte'),
    ],
  }] : [];
  if(exits){
    if(!Object.keys(exits).length||Object.keys(exits).some(a=>a!=='WETH'&&a!=='cbBTC'))throw Error('Choose supported exit assets.');
    for(const asset of ['WETH','cbBTC'] as const){
      const units=exits[asset];if(units===undefined)continue;
      if(!/^[1-9]\d{0,29}$/.test(units))throw Error('Exit amount must be bounded.');
      const deadline=String(Math.floor((seat.expiresAt+EXIT_GRACE_MS)/1000));
      rules.push({name:`Bounded ${asset} exits`,method:'eth_signTypedData_v4',action:'ALLOW',conditions:[...common,
        {field_source:'system',field:'current_unix_timestamp',operator:'lt',value:deadline},
        msg('fromToken',TOKENS[asset].address),msg('toToken',TOKENS.USDC.address),msg('fromAmount',units,'lte'),msg('deadline',deadline,'lte'),
      ]});
    }
  }
  return {version:'1.0',name:`Swipr pass ${seat.id.slice(2,18)}`,chain_type:'ethereum',rules};
}

export const canonical=(value:unknown):string=>{
 if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k])).join(',')+'}';
 throw Error('Invalid canonical JSON value.');
};

/** Privy adds rule IDs and checksum-normalizes address values when storing a policy. */
export function comparableRules(rules:Record<string,any>[]){
 const address=(value:unknown)=>typeof value==='string'&&/^0x[0-9a-f]{40}$/i.test(value)?value.toLowerCase():value;
 return rules.map(({id:_id,...rule})=>({...rule,conditions:rule.conditions.map((condition:Record<string,any>)=>({...condition,value:Array.isArray(condition.value)?condition.value.map(address):address(condition.value)}))}));
}
