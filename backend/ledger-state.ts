import type { Terms } from '../shared/types';

export type Micros = string;
export type PassStatus = 'requested' | 'accepted' | 'active';
export type Pass = {
  id: string; wallet: string; traderId: string; terms: Terms; status: PassStatus;
  perTradeMicros: Micros; capMicros: Micros; heldMicros: Micros; spentMicros: Micros;
  availableMicros: Micros; entries: number; tradeCount: number;
  activatedAt: string | null; expiresAt: string | null; createdAt: string;
};
export type Reservation = {
  id: string; passId: string; signalId: string; amountMicros: Micros;
  filledMicros: Micros; remainingUnits: string; status: 'pending' | 'settled';
};
/** Produced by the host's chain verifier from a fetched receipt; never from a client. */
export type ChainProof = {
  chainId: number; txHash: string; blockNumber: number; confirmations: number; verifiedAt: string;
};
export type LedgerEvent = { seq: string; passId: string; kind: string; payload: unknown; createdAt: string };
export type Job = {
  id: string; kind: string; payload: unknown; status: 'queued' | 'running' | 'done' | 'dead';
  attempts: number; maxAttempts: number; leaseToken: string | null; lastError: string | null;
};
export type LedgerErrorCode = 'invalid' | 'not_found' | 'conflict' | 'state' | 'expired'
  | 'cap_exceeded' | 'count_exceeded' | 'lease_lost' | 'read_only' | 'stale';

export class LedgerError extends Error {
  constructor(readonly code: LedgerErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LedgerError';
  }
}

/** Journal commands. JSON only (no bigint) so they replay identically from Arkiv. */
export type Command =
  | { type: 'pass.request'; passId: string; wallet: string; traderId: string; requestKey: string; terms: Terms }
  | { type: 'pass.accept' | 'pass.activate'; passId: string; proof: ChainProof }
  | { type: 'entry.reserve'; reservationId: string; passId: string; signalId: string; key: string; amountMicros: string }
  | { type: 'entry.reconcile'; reservationId: string; filledMicros: string; remainingUnits: string;
      terminal: boolean; evidence: Record<string, unknown> }
  | { type: 'job.enqueue'; kind: string; payload: unknown; dedupeKey: string | null; delayMs: number; maxAttempts: number }
  | { type: 'job.claim'; kinds: string[]; leaseMs: number; leaseToken: string }
  | { type: 'job.complete'; jobId: string; leaseToken: string }
  | { type: 'job.fail'; jobId: string; leaseToken: string; error: string; retryDelayMs: number };

export type PassRow = {
  id: string; wallet: string; traderId: string; requestKey: string; terms: Terms; status: PassStatus;
  perTrade: bigint; cap: bigint; held: bigint; spent: bigint; entries: number;
  createdAt: number; activatedAt: number | null; expiresAt: number | null;
  proofs: Partial<Record<'accept' | 'activate', ChainProof>>;
};
export type ReservationRow = {
  id: string; passId: string; signalId: string; key: string; amount: bigint;
  filled: bigint; units: bigint; status: 'pending' | 'settled';
};
export type JobRow = Job & { leaseUntil: number | null; runAfter: number; dedupeKey: string | null; doneToken: string | null };
export type State = {
  revision: number; at: number;
  passes: Map<string, PassRow>; requestKeys: Map<string, string>; proofsUsed: Set<string>;
  reservations: Map<string, ReservationRow>; reservationKeys: Map<string, string>;
  jobs: Map<string, JobRow>; dedupe: Map<string, string>; nextJob: number;
  events: LedgerEvent[];
};

export const MICROS_PER_USD = 1_000_000n;
export const fail = (code: LedgerErrorCode, message: string): never => { throw new LedgerError(code, message); };
export const check = (ok: boolean, message: string) => { if (!ok) fail('invalid', message); };
export const intIn = (value: unknown, min: number, max: number) =>
  Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;

export const emptyState = (): State => ({
  revision: 0, at: 0, passes: new Map(), requestKeys: new Map(), proofsUsed: new Set(),
  reservations: new Map(), reservationKeys: new Map(), jobs: new Map(), dedupe: new Map(), nextJob: 1, events: [],
});

const day = 86_400_000;
const iso = (ms: number | null) => ms === null ? null : new Date(ms).toISOString();
export const requestKeyOf = (wallet: string, key: string) => `${wallet}\n${key}`;
export const proofKeyOf = (kind: string, p: ChainProof) => `${kind}\n${p.chainId}\n${p.txHash}`;
export const entryKeyOf = (passId: string, kind: 'key' | 'signal', value: string) => `${passId}\n${kind}\n${value}`;

export function passView(row: PassRow): Pass {
  return {
    id: row.id, wallet: row.wallet, traderId: row.traderId, terms: row.terms, status: row.status,
    perTradeMicros: row.perTrade.toString(), capMicros: row.cap.toString(), heldMicros: row.held.toString(),
    spentMicros: row.spent.toString(), availableMicros: (row.cap - row.held - row.spent).toString(),
    entries: row.entries, tradeCount: row.terms.tradeCount, activatedAt: iso(row.activatedAt),
    expiresAt: iso(row.expiresAt), createdAt: iso(row.createdAt)!,
  };
}

export const reservationView = (row: ReservationRow): Reservation => ({
  id: row.id, passId: row.passId, signalId: row.signalId, amountMicros: row.amount.toString(),
  filledMicros: row.filled.toString(), remainingUnits: row.units.toString(), status: row.status,
});

export const jobView = (row: JobRow): Job => ({
  id: row.id, kind: row.kind, payload: row.payload, status: row.status, attempts: row.attempts,
  maxAttempts: row.maxAttempts, leaseToken: row.leaseToken, lastError: row.lastError,
});

export const getPassRow = (state: State, passId: string) => state.passes.get(passId) ?? fail('not_found', 'pass not found');

/** Jobs that a claim at `at` would dead-letter, and the next one it would lease. */
export function claimPlan(state: State, kinds: string[], at: number) {
  const ofKind = [...state.jobs.values()].filter(job => kinds.includes(job.kind));
  const expired = (job: JobRow) => job.status === 'running' && job.leaseUntil! < at;
  const dead = ofKind.filter(job => expired(job) && job.attempts >= job.maxAttempts);
  const next = ofKind.filter(job => !dead.includes(job)
      && ((job.status === 'queued' && job.runAfter <= at) || expired(job)))
    .sort((a, b) => a.runAfter - b.runAfter || Number(a.id) - Number(b.id))[0] ?? null;
  return { dead, next };
}

function heldLease(state: State, jobId: string, token: string, at: number) {
  const job = state.jobs.get(jobId);
  const held = job?.status === 'running' && job.leaseToken === token && job.leaseUntil! > at;
  return held ? job! : fail('lease_lost', 'job lease no longer held');
}

function record(state: State, passId: string, kind: string, payload: unknown) {
  state.events.push({ seq: String(state.revision), passId, kind, payload, createdAt: iso(state.at)! });
}

/**
 * Deterministic reducer shared by writes and replay. Mutates `state`; throws
 * LedgerError without partial effects when the command is invalid for it.
 * Callers have already shape-validated inputs; replay trusts only the journal.
 */
export function apply(state: State, revision: number, at: number, command: Command): void {
  state.revision = revision;
  state.at = at;
  switch (command.type) {
    case 'pass.request': {
      const key = requestKeyOf(command.wallet, command.requestKey);
      if (state.requestKeys.has(key) || state.passes.has(command.passId)) fail('conflict', 'pass already requested');
      const perTrade = BigInt(command.terms.perTradeUsd) * MICROS_PER_USD;
      state.passes.set(command.passId, {
        id: command.passId, wallet: command.wallet, traderId: command.traderId, requestKey: command.requestKey,
        terms: command.terms, status: 'requested', perTrade, cap: perTrade * BigInt(command.terms.tradeCount),
        held: 0n, spent: 0n, entries: 0, createdAt: at, activatedAt: null, expiresAt: null, proofs: {},
      });
      state.requestKeys.set(key, command.passId);
      return record(state, command.passId, 'pass_requested', { traderId: command.traderId, terms: command.terms });
    }
    case 'pass.accept':
    case 'pass.activate': {
      const kind = command.type === 'pass.accept' ? 'accept' : 'activate';
      const [from, to] = kind === 'accept' ? ['requested', 'accepted'] as const : ['accepted', 'active'] as const;
      const pass = getPassRow(state, command.passId);
      if (pass.status !== from) fail('state', `pass is ${pass.status}, expected ${from}`);
      const used = proofKeyOf(kind, command.proof);
      if (state.proofsUsed.has(used)) fail('conflict', 'chain proof already used');
      state.proofsUsed.add(used);
      pass.proofs[kind] = command.proof;
      pass.status = to;
      if (to === 'active') {
        pass.activatedAt = at;
        pass.expiresAt = at + pass.terms.durationDays * day;
      }
      return record(state, pass.id, kind === 'accept' ? 'pass_accepted' : 'pass_activated',
        { status: to, proof: command.proof });
    }
    case 'entry.reserve': {
      const pass = getPassRow(state, command.passId);
      const byKey = entryKeyOf(pass.id, 'key', command.key);
      const bySignal = entryKeyOf(pass.id, 'signal', command.signalId);
      const reused = state.reservationKeys.has(byKey) || state.reservations.has(command.reservationId);
      if (reused) fail('conflict', 'idempotency key already used');
      if (state.reservationKeys.has(bySignal)) fail('conflict', 'signal already reserved for this pass');
      if (pass.status !== 'active') fail('state', `pass is ${pass.status}`);
      if (pass.expiresAt! <= at) fail('expired', 'pass has expired');
      if (pass.entries >= pass.terms.tradeCount) fail('count_exceeded', 'trade count used');
      const amount = BigInt(command.amountMicros);
      if (amount > pass.perTrade) fail('cap_exceeded', 'amount above per-trade limit');
      if (pass.held + pass.spent + amount > pass.cap) fail('cap_exceeded', 'cumulative pass budget used');
      state.reservations.set(command.reservationId, {
        id: command.reservationId, passId: pass.id, signalId: command.signalId, key: command.key,
        amount, filled: 0n, units: 0n, status: 'pending',
      });
      state.reservationKeys.set(byKey, command.reservationId);
      state.reservationKeys.set(bySignal, command.reservationId);
      pass.held += amount;
      pass.entries += 1;
      return record(state, pass.id, 'entry_reserved', {
        reservationId: command.reservationId, signalId: command.signalId, amountMicros: command.amountMicros,
      });
    }
    case 'entry.reconcile': {
      const entry = state.reservations.get(command.reservationId) ?? fail('not_found', 'reservation not found');
      const pass = getPassRow(state, entry.passId);
      const filled = BigInt(command.filledMicros);
      if (entry.status === 'settled') fail('state', 'reservation already settled');
      if (filled < entry.filled) fail('invalid', 'filledMicros cannot decrease');
      if (filled > entry.amount) fail('cap_exceeded', 'fill exceeds reservation');
      // Fill moves from held to spent; terminal releases only the unfilled remainder.
      const released = command.terminal ? entry.amount - filled : 0n;
      pass.spent += filled - entry.filled;
      pass.held -= filled - entry.filled + released;
      if (command.terminal && filled === 0n) pass.entries -= 1;
      entry.filled = filled;
      entry.units = BigInt(command.remainingUnits);
      entry.status = command.terminal ? 'settled' : 'pending';
      return record(state, pass.id, command.terminal ? 'entry_settled' : 'entry_reconciled', {
        reservationId: entry.id, filledMicros: command.filledMicros, remainingUnits: command.remainingUnits,
        releasedMicros: released.toString(), evidence: command.evidence,
      });
    }
    case 'job.enqueue': {
      if (command.dedupeKey !== null && state.dedupe.has(command.dedupeKey)) fail('conflict', 'job already queued');
      const id = String(state.nextJob++);
      state.jobs.set(id, {
        id, kind: command.kind, payload: command.payload, status: 'queued', attempts: 0,
        maxAttempts: command.maxAttempts, leaseToken: null, lastError: null, leaseUntil: null,
        runAfter: at + command.delayMs, dedupeKey: command.dedupeKey, doneToken: null,
      });
      if (command.dedupeKey !== null) state.dedupe.set(command.dedupeKey, id);
      return;
    }
    case 'job.claim': {
      const { dead, next } = claimPlan(state, command.kinds, at);
      if (!dead.length && !next) fail('state', 'nothing to claim');
      for (const job of dead) {
        Object.assign(job, { status: 'dead', leaseToken: null, leaseUntil: null, lastError: job.lastError ?? 'lease expired' });
      }
      if (next) {
        Object.assign(next, { status: 'running', attempts: next.attempts + 1,
          leaseToken: command.leaseToken, leaseUntil: at + command.leaseMs });
      }
      return;
    }
    case 'job.complete': {
      const job = heldLease(state, command.jobId, command.leaseToken, at);
      Object.assign(job, { status: 'done', leaseToken: null, leaseUntil: null, doneToken: command.leaseToken });
      return;
    }
    case 'job.fail': {
      const job = heldLease(state, command.jobId, command.leaseToken, at);
      Object.assign(job, { leaseToken: null, leaseUntil: null, lastError: command.error,
        status: job.attempts >= job.maxAttempts ? 'dead' : 'queued', runAfter: at + command.retryDelayMs });
      return;
    }
    default: fail('invalid', 'unknown command');
  }
}
