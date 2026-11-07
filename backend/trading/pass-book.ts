import { randomUUID } from 'node:crypto';
import { withJournalWrite, type Journal, type JournalEvent } from '../arkiv-journal';
import { ApiError } from '../auth';
import type { Asset } from '../providers/flash';
export type PassFill = { txHash: string; asset: Asset; side: 'buy' | 'sell'; units: string; cash: string; timestamp?: number };
type Fill = { type: 'project.lifecycle.fill'; seatId: string; orderId: string; fill: PassFill };
type Mark = { type: 'project.lifecycle.mark'; seatId: string; pnl: string; paused: boolean; ended: boolean };
type Exit = { type: 'project.lifecycle.exit'; seatId: string; quoteId: string; asset: Asset; units: string; reason: string };
type Submit = { type: 'project.lifecycle.submit'; quoteId: string; orderId: string };
type Terminal = { type: 'project.lifecycle.terminal'; orderId: string };
type Settlement = { type: 'project.lifecycle.settlement'; seatId: string; amount: string; txHash: string | null };
type Command = Fill | Mark | Exit | Submit | Terminal | Settlement;
export type ExitRow = Exit & { orderId?: string; terminal?: boolean };
export type PassRecord = { fills: (Fill & { at: number })[]; highWater: bigint; paused: boolean; ended: boolean; endedAt?: number; exits: ExitRow[]; settlement?: Settlement };
const fail = (message: string): never => { throw new ApiError(409, 'pass_state', message); };
const uint = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9]\d{0,29})$/.test(v);
const hash = (v: unknown) => typeof v === 'string' && /^0x[0-9a-f]{64}$/i.test(v);
const key = (v: unknown) => typeof v === 'string' && /^[a-z0-9_-]{1,128}$/i.test(v);
export const isPassCommand = (v: unknown) => !!v && typeof v === 'object' && String((v as Command).type).startsWith('project.lifecycle.');
export function validatePassCommand(raw: unknown): Command {
 const c = raw as Command;
 if (!c || !isPassCommand(c)) return fail('Invalid pass history.');
 if ('seatId' in c && !hash(c.seatId)) return fail('Invalid pass ID.');
 switch (c.type) {
  case 'project.lifecycle.fill':
   if (!key(c.orderId) || !c.fill || !hash(c.fill.txHash) || !['WETH','cbBTC'].includes(c.fill.asset) || !['buy','sell'].includes(c.fill.side) || !uint(c.fill.units) || c.fill.units === '0' || !uint(c.fill.cash) || c.fill.cash === '0') return fail('Invalid pass fill.'); if(c.fill.timestamp!==undefined && (!Number.isSafeInteger(c.fill.timestamp)||c.fill.timestamp<=0))return fail('Invalid fill time.'); break;
  case 'project.lifecycle.mark':
   if (typeof c.pnl !== 'string' || !/^-?(0|[1-9]\d{0,29})$/.test(c.pnl) || typeof c.paused !== 'boolean' || typeof c.ended !== 'boolean') return fail('Invalid pass mark.'); break;
  case 'project.lifecycle.exit':
   if (!key(c.quoteId) || !key(c.reason) || !['WETH','cbBTC'].includes(c.asset) || !uint(c.units) || c.units === '0') return fail('Invalid pass exit.'); break;
  case 'project.lifecycle.submit': if (!key(c.quoteId) || !key(c.orderId)) return fail('Invalid pass order.'); break;
  case 'project.lifecycle.terminal': if (!key(c.orderId)) return fail('Invalid terminal order.'); break;
  case 'project.lifecycle.settlement': if (!uint(c.amount) || (c.txHash !== null && !hash(c.txHash)) || (c.amount !== '0' && !c.txHash)) return fail('Invalid settlement proof.'); break;
  default: return fail('Unknown pass command.');
 }
 return c;
}
const empty = (): PassRecord => ({ fills: [], highWater: 0n, paused: false, ended: false, exits: [] });
export function passRecords(events: JournalEvent[]): Map<string, PassRecord> {
 const records = new Map<string, PassRecord>(), quotes = new Map<string, ExitRow>(), orders = new Set<string>(), receipts = new Set<string>();
 for (const e of events) {
  if (!isPassCommand(e.command)) continue;
  const c = validatePassCommand(e.command);
  const row = 'seatId' in c ? records.get(c.seatId) ?? empty() : undefined;
  if (row && 'seatId' in c) records.set(c.seatId, row);
  switch (c.type) {
   case 'project.lifecycle.fill':
    if (receipts.has(c.fill.txHash.toLowerCase())) fail('A receipt was attributed twice.');
    receipts.add(c.fill.txHash.toLowerCase()); row!.fills.push({ ...c, at: c.fill.timestamp ?? e.at }); break;
   case 'project.lifecycle.mark': {
    const pnl = BigInt(c.pnl); if (pnl > row!.highWater) row!.highWater = pnl;
    row!.paused ||= c.paused; if(c.ended && !row!.ended)row!.endedAt=e.at; row!.ended ||= c.ended; break;
   }
   case 'project.lifecycle.exit': {
    if (quotes.has(c.quoteId) || row!.settlement) fail('Invalid exit sequence.');
    const exit = { ...c }; quotes.set(c.quoteId, exit); row!.exits.push(exit); break;
   }
   case 'project.lifecycle.submit': {
    const exit = quotes.get(c.quoteId); if (!exit || exit.orderId || orders.has(c.orderId)) fail('Invalid exit submission.');
    exit!.orderId = c.orderId; orders.add(c.orderId); break;
   }
   case 'project.lifecycle.terminal': {
    const exit = [...quotes.values()].find(x => x.orderId === c.orderId); if (!exit || exit.terminal) fail('Invalid exit reconciliation.'); exit!.terminal = true; break;
   }
   case 'project.lifecycle.settlement':
    if (row!.settlement || !row!.ended || row!.exits.some(x => !x.terminal)) fail('Pass cannot be settled yet.');
    if (c.txHash && [...records.values()].some(r => r.settlement?.txHash === c.txHash)) fail('Settlement receipt already used.');
    row!.settlement = c; break;
  }
 }
 return records;
}
/** Integer cash-flow attribution. Sells can never consume another pass's inventory. */
export function portfolio(row: PassRecord) {
 const positions = new Map<Asset, { units: bigint; cost: bigint }>(); let realized = 0n;
 for (const { fill } of row.fills) {
  const p = positions.get(fill.asset) ?? { units: 0n, cost: 0n }; positions.set(fill.asset, p);
  const units = BigInt(fill.units), cash = BigInt(fill.cash);
  if (fill.side === 'buy') { p.units += units; p.cost += cash; }
  else {
   if (units > p.units) fail('Exit exceeds attributed inventory.');
   const cost = units === p.units ? p.cost : p.cost * units / p.units;
   p.units -= units; p.cost -= cost; realized += cash - cost;
  }
 }
 return { positions, realized };
}
export const profitShare = (realized: bigint, bps = 500) => {
 const fee = realized > 0n ? realized * BigInt(bps) / 10000n : 0n;
 return fee >= 50000n ? fee : 0n;
};
export class PassBook {
 constructor(private journal: Journal) {}
 async state(seatId: string) { return passRecords((await this.journal.read()).events).get(seatId) ?? empty(); }
 async all() { return passRecords((await this.journal.read()).events); }
 private async write<T>(plan: (rows: Map<string, PassRecord>) => { command?: Command; result: T }): Promise<T> {
  return withJournalWrite(this.journal, async () => {
   const snapshot = await this.journal.read(), step = plan(passRecords(snapshot.events));
   if (step.command) {
    if (!this.journal.canWrite) fail('Pass accounting is unavailable.');
    const command = validatePassCommand(step.command), event = { revision: snapshot.nonce + 1, id: randomUUID(), at: snapshot.timestampMs, command };
    passRecords([...snapshot.events, event]);
    await this.journal.append(event, snapshot.nonce);
   }
   return step.result;
  });
 }
 fill(seatId: string, orderId: string, fill: PassFill) {
  return this.write<void>(rows => {
   const existing = [...rows.values()].flatMap(r => r.fills).find(f => f.fill.txHash.toLowerCase() === fill.txHash.toLowerCase());
   if (existing) {
    if (existing.seatId !== seatId || existing.orderId !== orderId || JSON.stringify(existing.fill) !== JSON.stringify(fill)) fail('Receipt attribution conflict.');
    return { result: undefined };
   }
   const row = rows.get(seatId) ?? empty();
   if (fill.side === 'sell') {
    const exit = row.exits.find(x => x.orderId === orderId);
    if (!exit || exit.asset !== fill.asset || row.fills.filter(f => f.orderId === orderId).reduce((n,f) => n + BigInt(f.fill.units), 0n) + BigInt(fill.units) > BigInt(exit.units)) fail('Exit fill exceeds its reservation.');
   } else if (row.settlement) fail('A settled pass cannot acquire inventory.');
   return { command: { type: 'project.lifecycle.fill', seatId, orderId, fill }, result: undefined };
  });
 }
 mark(seatId: string, pnl: bigint, threshold: bigint, end = false) {
  return this.write<void>(rows => {
   const row = rows.get(seatId) ?? empty(), high = pnl > row.highWater ? pnl : row.highWater;
   const paused = row.paused || end || pnl <= high - threshold;
   if (high === row.highWater && paused === row.paused && (!end || row.ended)) return { result: undefined };
   return { command: { type: 'project.lifecycle.mark', seatId, pnl: pnl.toString(), paused, ended: row.ended || end }, result: undefined };
  });
 }
 reserve(seatId: string, quoteId: string, asset: Asset, units: bigint, reason: string) {
  return this.write<{ created: boolean; orderId?: string }>(rows => {
   const row = rows.get(seatId) ?? empty(), prior = row.exits.find(x => x.quoteId === quoteId || x.asset === asset && x.reason === reason && !x.terminal);
   if (prior) return { result: { created: false, orderId: prior.orderId } };
   const owned = portfolio(row).positions.get(asset)?.units ?? 0n;
   const held = row.exits.filter(x => x.asset === asset && !x.terminal).reduce((n,x) => n + BigInt(x.units) - row.fills.filter(f => f.orderId === x.orderId).reduce((v,f) => v + BigInt(f.fill.units),0n),0n);
   if (units <= 0n || units > owned - held || row.settlement) fail('No unreserved inventory for this exit.');
   return { command: { type: 'project.lifecycle.exit', seatId, quoteId, asset, units: units.toString(), reason }, result: { created: true } };
  });
 }
 submitted(quoteId: string, orderId: string) { return this.write<void>(rows => {
  const exit = [...rows.values()].flatMap(r => r.exits).find(x => x.quoteId === quoteId);
  if (!exit) fail('Exit reservation missing.');
  if (exit!.orderId) { if (exit!.orderId !== orderId) fail('Exit order conflict.'); return { result: undefined }; }
  return { command: { type: 'project.lifecycle.submit', quoteId, orderId }, result: undefined };
 }); }
 terminal(orderId: string) { return this.write<void>(rows => {
  const exit = [...rows.values()].flatMap(r => r.exits).find(x => x.orderId === orderId);
  return !exit || exit.terminal ? { result: undefined } : { command: { type: 'project.lifecycle.terminal', orderId }, result: undefined };
 }); }
 settle(seatId: string, amount: bigint, txHash: string | null) { return this.write<void>(rows => {
  const row = rows.get(seatId) ?? empty(), p = portfolio(row);
  if (row.settlement) { if (row.settlement.amount !== amount.toString() || row.settlement.txHash !== txHash) fail('Settlement conflict.'); return { result: undefined }; }
  if ([...p.positions.values()].some(x => x.units > 0n) || amount !== profitShare(p.realized)) fail('Close this pass before settlement.');
  return { command: { type: 'project.lifecycle.settlement', seatId, amount: amount.toString(), txHash }, result: undefined };
 }); }
}
