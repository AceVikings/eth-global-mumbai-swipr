import type { Terms } from './types';
export type PassRequest = { traderId: string; traderOwner: string; terms: Terms };
export const ENTITY_KEY = /^0x[0-9a-f]{64}$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
function object(value: unknown, keys: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(k => !keys.includes(k))) throw new Error('Invalid pass record.');
  return value as Record<string, unknown>;
}
const integer = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
export function parsePassTerms(value: unknown): Terms {
  const t = object(value, ['perTradeUsd', 'tradeCount', 'durationDays', 'mode', 'breakupUsd', 'safetyNetBps', 'profitShareBps', 'liquidateOnBreakup']);
  if (!integer(t.perTradeUsd, 5, 50) || !integer(t.tradeCount, 1, 20)
    || ![1, 7, 30].includes(Number(t.durationDays)) || typeof t.durationDays !== 'number'
    || !['tap', 'auto'].includes(String(t.mode)) || !integer(t.breakupUsd, 1, Number(t.perTradeUsd) * Number(t.tradeCount))
    || !integer(t.safetyNetBps, 0, 10000) || t.profitShareBps !== 500 || typeof t.liquidateOnBreakup !== 'boolean') throw new Error('Invalid pass terms.');
  // Keep serialized terms deterministic.
  return { perTradeUsd: t.perTradeUsd as number, tradeCount: t.tradeCount as number,
    durationDays: t.durationDays as Terms['durationDays'], mode: t.mode as Terms['mode'],
    breakupUsd: t.breakupUsd as number, safetyNetBps: t.safetyNetBps as number,
    profitShareBps: 500, liquidateOnBreakup: t.liquidateOnBreakup };
}
export function parsePassRequest(value: unknown): PassRequest {
  const r = object(value, ['traderId', 'traderOwner', 'terms']);
  if (typeof r.traderId !== 'string' || !ENTITY_KEY.test(r.traderId)
    || typeof r.traderOwner !== 'string' || !ADDRESS.test(r.traderOwner)) throw new Error('Invalid pass trader.');
  return { traderId: r.traderId.toLowerCase(), traderOwner: r.traderOwner.toLowerCase(), terms: parsePassTerms(r.terms) };
}
