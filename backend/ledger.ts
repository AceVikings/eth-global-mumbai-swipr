import { isSocialCommand, replaySocial, validateSocialCommand } from './social/store';
import { isProjectCommand, replayProject, validateProjectCommand } from './bots/store';
import { randomUUID } from 'node:crypto';
import type { Terms } from '../shared/types';
import { withJournalWrite, type Journal, type JournalSnapshot } from './arkiv-journal';
import {
  apply, check, claimPlan, emptyState, entryKeyOf, fail, getPassRow, intIn, jobView, LedgerError, passView, requestKeyOf, reservationView, type ChainProof, type Command, type Job, type LedgerEvent,
  type Pass, type Reservation, type State,
} from './ledger-state';

export { LedgerError } from './ledger-state';
export type { ChainProof, Job, LedgerErrorCode, LedgerEvent, Micros, Pass, PassStatus, Reservation } from './ledger-state';

export const SCHEMA_VERSION = 1;

export function freezeTerms(terms: Terms): Terms {
  check(!!terms && typeof terms === 'object', 'terms are required');
  check(intIn(terms.perTradeUsd, 5, 50), 'perTradeUsd must be whole dollars 5-50');
  check(intIn(terms.tradeCount, 1, 20), 'tradeCount must be 1-20');
  check([1, 7, 30].includes(terms.durationDays), 'durationDays must be 1, 7 or 30');
  check(terms.mode === 'tap' || terms.mode === 'auto', 'mode must be tap or auto');
  check(intIn(terms.breakupUsd, 0, 1_000_000), 'breakupUsd must be whole dollars');
  check(intIn(terms.safetyNetBps, 0, 10_000), 'safetyNetBps must be 0-10000');
  check(intIn(terms.profitShareBps, 0, 1_000), 'profitShareBps must be 0-1000');
  check(typeof terms.liquidateOnBreakup === 'boolean', 'liquidateOnBreakup must be boolean');
  // Copy known keys only so extra client fields never become part of frozen terms.
  return Object.freeze({
    perTradeUsd: terms.perTradeUsd, tradeCount: terms.tradeCount, durationDays: terms.durationDays,
    mode: terms.mode, breakupUsd: terms.breakupUsd, safetyNetBps: terms.safetyNetBps,
    profitShareBps: terms.profitShareBps, liquidateOnBreakup: terms.liquidateOnBreakup,
  });
}

export function toMicros(value: string | bigint, label: string, allowZero = false): bigint {
  const text = typeof value === 'bigint' ? value.toString() : value;
  check(typeof text === 'string' && /^\d{1,30}$/.test(text), `${label} must be an integer string`);
  const result = BigInt(text);
  check(allowZero || result > 0n, `${label} must be positive`);
  return result;
}

function wallet(value: string) {
  const normalized = String(value).toLowerCase();
  check(/^0x[0-9a-f]{40}$/.test(normalized), 'wallet must be a 0x address');
  return normalized;
}

function key(value: string, label: string) {
  check(typeof value === 'string' && value.length > 0 && value.length <= 200, `${label} is required`);
  return value;
}

function proof(evidence: ChainProof): ChainProof {
  check(!!evidence && typeof evidence === 'object', 'chain proof is required');
  check(intIn(evidence.chainId, 1, Number.MAX_SAFE_INTEGER), 'proof chainId invalid');
  check(/^0x[0-9a-fA-F]{64}$/.test(evidence.txHash), 'proof txHash invalid');
  check(intIn(evidence.blockNumber, 0, Number.MAX_SAFE_INTEGER), 'proof blockNumber invalid');
  check(intIn(evidence.confirmations, 1, Number.MAX_SAFE_INTEGER), 'proof needs a confirmation');
  check(!Number.isNaN(Date.parse(evidence.verifiedAt)), 'proof verifiedAt invalid');
  return { chainId: evidence.chainId, txHash: evidence.txHash.toLowerCase(),
    blockNumber: evidence.blockNumber, confirmations: evidence.confirmations, verifiedAt: evidence.verifiedAt };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (value: string, label: string) => { check(UUID.test(String(value)), `${label} invalid`); return value; };
const jobKey = (value: string) => { check(/^\d{1,18}$/.test(String(value)), 'jobId invalid'); return value; };
const SECRET_KEY = /signature|secret|private|password|mnemonic|seed|authorization|bearer|api_?key/i;
const SIGNATURE = /^0x[0-9a-f]{130}$/i;

/** The journal is public chain data: refuse anything that looks like a secret or signature. */
function publicData<T>(value: T, label: string): T {
  const text = JSON.stringify(value ?? null);
  check(text.length <= 8192, `${label} is too large`);
  JSON.parse(text, (field, inner) => {
    check(!SECRET_KEY.test(field) && !(typeof inner === 'string' && SIGNATURE.test(inner)),
      `${label} must not contain secrets or signatures`);
    return inner;
  });
  return JSON.parse(text);
}

const redact = (error: string) => String(error).slice(0, 500)
  .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]').replace(/0x[0-9a-f]{130}/gi, '[signature]');

/** Shape-validates a command exactly as the write path built it; replay uses this too. */
function validate(raw: unknown): Command {
  const c = raw as Command & Record<string, any>;
  check(!!c && typeof c === 'object', 'command invalid');
  switch (c.type) {
    case 'pass.request':
      return { type: c.type, passId: uuid(c.passId, 'passId'), wallet: wallet(c.wallet),
        traderId: key(c.traderId, 'traderId'), requestKey: key(c.requestKey, 'idempotencyKey'), terms: freezeTerms(c.terms) };
    case 'pass.accept': case 'pass.activate':
      return { type: c.type, passId: uuid(c.passId, 'passId'), proof: proof(c.proof) };
    case 'entry.reserve':
      return { type: c.type, reservationId: uuid(c.reservationId, 'reservationId'), passId: uuid(c.passId, 'passId'),
        signalId: key(c.signalId, 'signalId'), key: key(c.key, 'idempotencyKey'),
        amountMicros: toMicros(c.amountMicros, 'amountMicros').toString() };
    case 'entry.reconcile':
      check(typeof c.terminal === 'boolean', 'terminal must be boolean');
      check(!!c.evidence && typeof c.evidence === 'object' && !Array.isArray(c.evidence)
        && Object.keys(c.evidence).length > 0, 'evidence is required');
      return { type: c.type, reservationId: uuid(c.reservationId, 'reservationId'),
        filledMicros: toMicros(c.filledMicros, 'filledMicros', true).toString(),
        remainingUnits: toMicros(c.remainingUnits, 'remainingUnits', true).toString(),
        terminal: c.terminal, evidence: publicData(c.evidence, 'evidence') };
    case 'job.enqueue':
      check(intIn(c.delayMs, 0, 31 * 86_400_000) && intIn(c.maxAttempts, 1, 100), 'job options invalid');
      return { type: c.type, kind: key(c.kind, 'kind'), payload: publicData(c.payload, 'payload'),
        dedupeKey: c.dedupeKey === null ? null : key(c.dedupeKey, 'dedupeKey'), delayMs: c.delayMs, maxAttempts: c.maxAttempts };
    case 'job.claim':
      check(Array.isArray(c.kinds) && c.kinds.length > 0, 'kinds required');
      check(intIn(c.leaseMs, 1, 3_600_000), 'leaseMs invalid');
      return { type: c.type, kinds: c.kinds.map((k: string) => key(k, 'kind')), leaseMs: c.leaseMs,
        leaseToken: uuid(c.leaseToken, 'leaseToken') };
    case 'job.complete': return { type: c.type, jobId: jobKey(c.jobId), leaseToken: uuid(c.leaseToken, 'leaseToken') };
    case 'job.fail':
      check(intIn(c.retryDelayMs, 0, 86_400_000), 'retryDelayMs invalid');
      return { type: c.type, jobId: jobKey(c.jobId), leaseToken: uuid(c.leaseToken, 'leaseToken'),
        error: redact(c.error), retryDelayMs: c.retryDelayMs };
    default: return fail('invalid', 'unknown command');
  }
}

/** Full replay. Any gap, duplicate or invalid command fails closed. */
function replay(snapshot: JournalSnapshot): State {
  const state = emptyState();
  const ids = new Set<string>();
  if (snapshot.events.length !== snapshot.nonce) throw new Error('ledger_journal_incomplete');
  replaySocial(snapshot.events);
  replayProject(snapshot.events); // validate bot ownership and replay constraints too
  snapshot.events.forEach((event, index) => {
    if (event.revision !== index + 1 || ids.has(event.id) || !Number.isSafeInteger(event.at) || event.at < state.at) {
      throw new Error(`ledger_journal_invalid at revision ${index + 1}`);
    }
    ids.add(event.id);
    if (isSocialCommand(event.command)) {
      validateSocialCommand(event.command);
      state.revision = event.revision; state.at = event.at;
      return;
    }
    if (isProjectCommand(event.command)) {
      validateProjectCommand(event.command);
      state.revision = event.revision; state.at = event.at;
      return;
    }
    try {
      apply(state, event.revision, event.at, validate(event.command));
    } catch (error) {
      throw new Error(`ledger_journal_invalid at revision ${event.revision}`, { cause: error });
    }
  });
  return state;
}

const cmd = <K extends Command['type']>(type: K, fields: Record<string, unknown>) =>
  validate({ type, ...fields }) as Extract<Command, { type: K }>;

type Plan<T> = { done: T } | { command: Command; result: (state: State) => T };

export class Ledger {
  

  private constructor(private readonly journal: Journal) {}

  static async open(journal: Journal): Promise<Ledger> {
    replay(await journal.read());
    return new Ledger(journal);
  }

  get canWrite() { return this.journal.canWrite; }

  async close() { await this.journal.close(); }

  async health(): Promise<{ ok: boolean; schemaVersion: 1; storage: 'arkiv'; blockNumber: string; canWrite: boolean }> {
    const base = { schemaVersion: 1 as const, storage: 'arkiv' as const, canWrite: this.journal.canWrite };
    const snapshot = await this.journal.read().then(read => { replay(read); return read; }).catch(() => null);
    return { ok: !!snapshot, ...base, blockNumber: snapshot ? snapshot.blockNumber.toString() : '0' };
  }

  /** Reads always replay the full journal; there is no cache or memory fallback. */
  private async state() { return replay(await this.journal.read()); }

  /** In-process serialization only; cross-process safety is the journal's nonce fence. */
  private write<T>(plan: (state: State, at: number) => Plan<T>): Promise<T> {
    if (!this.journal.canWrite) fail('read_only', 'ledger is read-only');
    const run = withJournalWrite(this.journal, async () => {
      const snapshot = await this.journal.read();
      const state = replay(snapshot);
      const at = Math.max(snapshot.timestampMs, state.at);
      const step = plan(state, at);
      if ('done' in step) return step.done;
      const command = validate(step.command);
      apply(state, snapshot.nonce + 1, at, command); // throws LedgerError before any append
      try {
        await this.journal.append({ revision: snapshot.nonce + 1, id: randomUUID(), at, command }, snapshot.nonce);
      } catch (error) {
        // No retry or recompute: the write may or may not have landed. Callers retry by idempotency key.
        throw new LedgerError('stale', 'journal append rejected or unconfirmed', { cause: error });
      }
      return step.result(state);
    });
    return run;
  }

  async requestPass(walletAddress: string, traderId: string, terms: Terms, idempotencyKey: string): Promise<Pass> {
    const command = cmd('pass.request', { passId: randomUUID(), wallet: walletAddress, traderId, requestKey: idempotencyKey, terms });
    return this.write<Pass>(state => {
      const existing = state.passes.get(state.requestKeys.get(requestKeyOf(command.wallet, command.requestKey)) ?? '');
      if (!existing) return { command, result: s => passView(getPassRow(s, command.passId)) };
      const same = existing.traderId === command.traderId
        && (Object.keys(command.terms) as (keyof Terms)[]).every(f => existing.terms[f] === command.terms[f]);
      return same ? { done: passView(existing) } : fail('conflict', 'idempotency key reused with different request');
    });
  }

  /** Trusted host only: call after the verifier confirmed the acceptance/mint receipt onchain. */
  acceptPass(passId: string, evidence: ChainProof) { return this.advance(passId, evidence, 'accept'); }

  /** Trusted host only: call after the verifier confirmed the wallet permission grant onchain. */
  activatePass(passId: string, evidence: ChainProof) { return this.advance(passId, evidence, 'activate'); }

  private async advance(passId: string, evidence: ChainProof, kind: 'accept' | 'activate'): Promise<Pass> {
    const command = cmd(kind === 'accept' ? 'pass.accept' : 'pass.activate', { passId, proof: evidence });
    const from = kind === 'accept' ? 'requested' : 'accepted';
    return this.write<Pass>(state => {
      const pass = getPassRow(state, passId);
      const prior = pass.proofs[kind];
      if (pass.status !== from && prior?.txHash === command.proof.txHash && prior.chainId === command.proof.chainId) {
        return { done: passView(pass) }; // replay of the same verified proof is a no-op
      }
      return { command, result: s => passView(getPassRow(s, passId)) };
    });
  }

  async reserveEntry(passId: string, signalId: string, amountMicros: string | bigint,
    idempotencyKey: string): Promise<Reservation> {
    const command = cmd('entry.reserve', { reservationId: randomUUID(), passId, signalId, key: idempotencyKey, amountMicros });
    return this.write<Reservation>(state => {
      getPassRow(state, passId);
      const existing = state.reservations.get(state.reservationKeys.get(entryKeyOf(passId, 'key', command.key)) ?? '');
      if (!existing) return { command, result: s => reservationView(s.reservations.get(command.reservationId)!) };
      const same = existing.signalId === command.signalId && existing.amount === BigInt(command.amountMicros);
      return same ? { done: reservationView(existing) } : fail('conflict', 'idempotency key reused with different entry');
    });
  }

  async reconcileEntry(reservationId: string, filledMicros: string | bigint, remainingUnits: string | bigint,
    terminal: boolean, evidence: Record<string, unknown>): Promise<Reservation> {
    const command = cmd('entry.reconcile', { reservationId, filledMicros, remainingUnits, terminal, evidence });
    return this.write<Reservation>(state => {
      const entry = state.reservations.get(reservationId) ?? fail('not_found', 'reservation not found');
      if (entry.status === 'settled') {
        const same = entry.filled === BigInt(command.filledMicros) && entry.units === BigInt(command.remainingUnits) && terminal;
        return same ? { done: reservationView(entry) } : fail('state', 'reservation already settled');
      }
      return { command, result: s => reservationView(s.reservations.get(reservationId)!) };
    });
  }

  async getPass(passId: string): Promise<Pass> {
    uuid(passId, 'passId');
    return passView(getPassRow(await this.state(), passId));
  }

  async listPasses(walletAddress: string): Promise<Pass[]> {
    const owner = wallet(walletAddress);
    return [...(await this.state()).passes.values()].filter(p => p.wallet === owner).map(passView);
  }

  async events(passId: string): Promise<LedgerEvent[]> {
    uuid(passId, 'passId');
    return (await this.state()).events.filter(e => e.passId === passId);
  }

  async enqueueJob(kind: string, payload: unknown,
    options: { dedupeKey?: string; delayMs?: number; maxAttempts?: number } = {}): Promise<Job> {
    const command = cmd('job.enqueue', { kind, payload, dedupeKey: options.dedupeKey ?? null,
      delayMs: options.delayMs ?? 0, maxAttempts: options.maxAttempts ?? 5 });
    return this.write<Job>(state => {
      const existing = command.dedupeKey === null ? undefined : state.jobs.get(state.dedupe.get(command.dedupeKey) ?? '');
      if (existing) return { done: jobView(existing) };
      const id = String(state.nextJob);
      return { command, result: s => jobView(s.jobs.get(id)!) };
    });
  }

  /** Claims the next ready job (or one whose lease expired). Each claim counts as an attempt. */
  async claimJob(kinds: string[], leaseMs: number): Promise<Job | null> {
    const command = cmd('job.claim', { kinds, leaseMs, leaseToken: randomUUID() });
    return this.write<Job | null>((state, at) => {
      const { dead, next } = claimPlan(state, command.kinds, at);
      if (!dead.length && !next) return { done: null };
      const id = next?.id;
      return { command, result: s => id ? jobView(s.jobs.get(id)!) : null };
    });
  }

  async completeJob(jobId: string, leaseToken: string): Promise<void> {
    const command = cmd('job.complete', { jobId, leaseToken });
    return this.write<void>(state => {
      const job = state.jobs.get(jobId);
      // A retry after a lost acknowledgement finds its own completion already recorded.
      if (job?.status === 'done' && job.doneToken === leaseToken) return { done: undefined };
      return { command, result: () => undefined };
    });
  }

  async failJob(jobId: string, leaseToken: string, error: string, retryDelayMs = 1_000): Promise<Job> {
    const command = cmd('job.fail', { jobId, leaseToken, error, retryDelayMs });
    return this.write<Job>(() => ({ command, result: s => jobView(s.jobs.get(jobId)!) }));
  }
}
