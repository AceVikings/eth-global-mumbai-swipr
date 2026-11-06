import { randomUUID } from 'node:crypto';
import type { Terms } from '../shared/types';
import { openDatabase, transaction, SCHEMA_VERSION, type Db, type Tx } from './database';

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
  | 'cap_exceeded' | 'count_exceeded' | 'lease_lost';

export class LedgerError extends Error {
  constructor(readonly code: LedgerErrorCode, message: string) {
    super(message);
    this.name = 'LedgerError';
  }
}

const MICROS_PER_USD = 1_000_000n;
const fail = (code: LedgerErrorCode, message: string): never => { throw new LedgerError(code, message); };
const check = (ok: boolean, message: string) => { if (!ok) fail('invalid', message); };
const intIn = (value: unknown, min: number, max: number) =>
  Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;

export function freezeTerms(terms: Terms): Terms {
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

type Row = Record<string, any>;
const iso = (value: Date | null) => value ? value.toISOString() : null;

function passFrom(row: Row): Pass {
  const available = BigInt(row.cap_micros) - BigInt(row.held_micros) - BigInt(row.spent_micros);
  return {
    id: row.id, wallet: row.wallet, traderId: row.trader_id, terms: row.terms, status: row.status,
    perTradeMicros: row.per_trade_micros, capMicros: row.cap_micros, heldMicros: row.held_micros,
    spentMicros: row.spent_micros, availableMicros: available.toString(), entries: row.entries,
    tradeCount: row.trade_count, activatedAt: iso(row.activated_at), expiresAt: iso(row.expires_at),
    createdAt: row.created_at.toISOString(),
  };
}

function reservationFrom(row: Row): Reservation {
  return {
    id: row.id, passId: row.pass_id, signalId: row.signal_id, amountMicros: row.amount_micros,
    filledMicros: row.filled_micros, remainingUnits: row.remaining_units, status: row.status,
  };
}

function jobFrom(row: Row): Job {
  return {
    id: row.id, kind: row.kind, payload: row.payload, status: row.status, attempts: row.attempts,
    maxAttempts: row.max_attempts, leaseToken: row.lease_token, lastError: row.last_error,
  };
}

async function event(tx: Tx, passId: string, kind: string, payload: unknown) {
  await tx.query('INSERT INTO ledger_events (pass_id, kind, payload) VALUES ($1, $2, $3)',
    [passId, kind, JSON.stringify(payload)]);
}

async function lockPass(tx: Tx, passId: string): Promise<Row> {
  const { rows } = await tx.query(
    'SELECT *, expires_at <= now() AS expired FROM passes WHERE id = $1 FOR UPDATE', [passId]);
  return rows[0] ?? fail('not_found', 'pass not found');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (value: string, label: string) => { check(UUID.test(String(value)), `${label} invalid`); return value; };
const jobKey = (value: string) => { check(/^\d{1,18}$/.test(String(value)), 'jobId invalid'); return value; };

export class Ledger {
  private constructor(private readonly db: Db) {}

  static async open(connectionString: string, options: { poolMax?: number } = {}): Promise<Ledger> {
    return new Ledger(await openDatabase(connectionString, options.poolMax));
  }

  async close() { await this.db.end(); }

  async health(): Promise<{ ok: boolean; schemaVersion: number }> {
    try {
      const { rows } = await this.db.query('SELECT schema_version FROM ledger_meta WHERE id = 1');
      return { ok: rows[0]?.schema_version === SCHEMA_VERSION, schemaVersion: rows[0]?.schema_version ?? 0 };
    } catch {
      return { ok: false, schemaVersion: 0 };
    }
  }

  async requestPass(walletAddress: string, traderId: string, terms: Terms, idempotencyKey: string): Promise<Pass> {
    const owner = wallet(walletAddress);
    key(traderId, 'traderId');
    key(idempotencyKey, 'idempotencyKey');
    const frozen = freezeTerms(terms);
    const perTrade = BigInt(frozen.perTradeUsd) * MICROS_PER_USD;
    return transaction(this.db, async tx => {
      const inserted = await tx.query(`INSERT INTO passes (id, wallet, trader_id, request_key, terms,
        per_trade_micros, cap_micros, trade_count, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'requested')
        ON CONFLICT (wallet, request_key) DO NOTHING RETURNING *`, [randomUUID(), owner, traderId,
        idempotencyKey, JSON.stringify(frozen), perTrade.toString(),
        (perTrade * BigInt(frozen.tradeCount)).toString(), frozen.tradeCount]);
      if (inserted.rows[0]) {
        await event(tx, inserted.rows[0].id, 'pass_requested', { traderId, terms: frozen });
        return passFrom(inserted.rows[0]);
      }
      const { rows } = await tx.query('SELECT * FROM passes WHERE wallet = $1 AND request_key = $2',
        [owner, idempotencyKey]);
      // jsonb reorders keys, so compare field by field.
      const same = rows[0].trader_id === traderId
        && (Object.keys(frozen) as (keyof Terms)[]).every(field => rows[0].terms[field] === frozen[field]);
      return same ? passFrom(rows[0]) : fail('conflict', 'idempotency key reused with different request');
    });
  }

  /** Trusted host only: call after the verifier confirmed the acceptance/mint receipt onchain. */
  acceptPass(passId: string, evidence: ChainProof) { return this.advance(passId, evidence, 'accept'); }

  /** Trusted host only: call after the verifier confirmed the wallet permission grant onchain. */
  activatePass(passId: string, evidence: ChainProof) { return this.advance(passId, evidence, 'activate'); }

  private async advance(passId: string, evidence: ChainProof, kind: 'accept' | 'activate'): Promise<Pass> {
    uuid(passId, 'passId');
    const verified = proof(evidence);
    const [from, to] = kind === 'accept' ? ['requested', 'accepted'] : ['accepted', 'active'];
    return transaction(this.db, async tx => {
      const pass = await lockPass(tx, passId);
      if (pass.status !== from) {
        const prior = await tx.query('SELECT tx_hash, chain_id FROM chain_proofs WHERE pass_id = $1 AND kind = $2',
          [passId, kind]);
        const replay = prior.rows[0]?.tx_hash === verified.txHash && Number(prior.rows[0]?.chain_id) === verified.chainId;
        return replay ? passFrom(pass) : fail('state', `pass is ${pass.status}, expected ${from}`);
      }
      const stored = await tx.query(`INSERT INTO chain_proofs (pass_id, kind, chain_id, tx_hash, block_number, proof)
        VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING RETURNING pass_id`, [passId, kind,
        verified.chainId, verified.txHash, verified.blockNumber, JSON.stringify(verified)]);
      if (!stored.rows[0]) fail('conflict', 'chain proof already used');
      const { rows } = await tx.query(kind === 'accept'
        ? `UPDATE passes SET status = 'accepted' WHERE id = $1 RETURNING *`
        : `UPDATE passes SET status = 'active', activated_at = now(),
            expires_at = now() + make_interval(days => (terms->>'durationDays')::int)
          WHERE id = $1 RETURNING *`, [passId]);
      await event(tx, passId, kind === 'accept' ? 'pass_accepted' : 'pass_activated', { status: to, proof: verified });
      return passFrom(rows[0]);
    });
  }

  async reserveEntry(passId: string, signalId: string, amountMicros: string | bigint,
    idempotencyKey: string): Promise<Reservation> {
    uuid(passId, 'passId');
    key(signalId, 'signalId');
    key(idempotencyKey, 'idempotencyKey');
    const amount = toMicros(amountMicros, 'amountMicros');
    return transaction(this.db, async tx => {
      const pass = await lockPass(tx, passId);
      const prior = await tx.query(
        'SELECT * FROM reservations WHERE pass_id = $1 AND (idempotency_key = $2 OR signal_id = $3)',
        [passId, idempotencyKey, signalId]);
      const existing = prior.rows.find(row => row.idempotency_key === idempotencyKey);
      if (existing) {
        const same = existing.signal_id === signalId && BigInt(existing.amount_micros) === amount;
        return same ? reservationFrom(existing) : fail('conflict', 'idempotency key reused with different entry');
      }
      if (prior.rows.length) fail('conflict', 'signal already reserved for this pass');
      if (pass.status !== 'active') fail('state', `pass is ${pass.status}`);
      if (pass.expired) fail('expired', 'pass has expired');
      if (pass.entries >= pass.trade_count) fail('count_exceeded', 'trade count used');
      if (amount > BigInt(pass.per_trade_micros)) fail('cap_exceeded', 'amount above per-trade limit');
      const used = BigInt(pass.held_micros) + BigInt(pass.spent_micros);
      if (used + amount > BigInt(pass.cap_micros)) fail('cap_exceeded', 'cumulative pass budget used');
      const id = randomUUID();
      const { rows } = await tx.query(`INSERT INTO reservations (id, pass_id, signal_id, idempotency_key,
        amount_micros, status) VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING *`,
        [id, passId, signalId, idempotencyKey, amount.toString()]);
      await tx.query('UPDATE passes SET held_micros = held_micros + $2, entries = entries + 1 WHERE id = $1',
        [passId, amount.toString()]);
      await event(tx, passId, 'entry_reserved', { reservationId: id, signalId, amountMicros: amount.toString() });
      return reservationFrom(rows[0]);
    });
  }

  async reconcileEntry(reservationId: string, filledMicros: string | bigint, remainingUnits: string | bigint,
    terminal: boolean, evidence: Record<string, unknown>): Promise<Reservation> {
    uuid(reservationId, 'reservationId');
    const filled = toMicros(filledMicros, 'filledMicros', true);
    const units = toMicros(remainingUnits, 'remainingUnits', true);
    check(typeof terminal === 'boolean', 'terminal must be boolean');
    check(!!evidence && typeof evidence === 'object' && Object.keys(evidence).length > 0, 'evidence is required');
    return transaction(this.db, async tx => {
      const owner = await tx.query('SELECT pass_id FROM reservations WHERE id = $1', [reservationId]);
      if (!owner.rows[0]) fail('not_found', 'reservation not found');
      const passId = owner.rows[0].pass_id;
      await lockPass(tx, passId); // lock order: pass then reservation
      const { rows } = await tx.query('SELECT * FROM reservations WHERE id = $1 FOR UPDATE', [reservationId]);
      const entry = rows[0];
      const amount = BigInt(entry.amount_micros);
      const previous = BigInt(entry.filled_micros);
      if (entry.status === 'settled') {
        const same = previous === filled && BigInt(entry.remaining_units) === units && terminal;
        return same ? reservationFrom(entry) : fail('state', 'reservation already settled');
      }
      if (filled < previous) fail('invalid', 'filledMicros cannot decrease');
      if (filled > amount) fail('cap_exceeded', 'fill exceeds reservation');
      // Fill moves from held to spent; terminal releases only the unfilled remainder.
      const released = terminal ? amount - filled : 0n;
      const freedSlot = terminal && filled === 0n ? 1 : 0;
      await tx.query(`UPDATE passes SET spent_micros = spent_micros + $2,
        held_micros = held_micros - $2 - $3, entries = entries - $4 WHERE id = $1`,
        [passId, (filled - previous).toString(), released.toString(), freedSlot]);
      const updated = await tx.query(`UPDATE reservations SET filled_micros = $2, remaining_units = $3,
        status = $4, updated_at = now() WHERE id = $1 RETURNING *`,
        [reservationId, filled.toString(), units.toString(), terminal ? 'settled' : 'pending']);
      await event(tx, passId, terminal ? 'entry_settled' : 'entry_reconciled', {
        reservationId, filledMicros: filled.toString(), remainingUnits: units.toString(),
        releasedMicros: released.toString(), evidence,
      });
      return reservationFrom(updated.rows[0]);
    });
  }

  async getPass(passId: string): Promise<Pass> {
    uuid(passId, 'passId');
    const { rows } = await this.db.query('SELECT * FROM passes WHERE id = $1', [passId]);
    return passFrom(rows[0] ?? fail('not_found', 'pass not found'));
  }

  async listPasses(walletAddress: string): Promise<Pass[]> {
    const { rows } = await this.db.query('SELECT * FROM passes WHERE wallet = $1 ORDER BY created_at, id',
      [wallet(walletAddress)]);
    return rows.map(passFrom);
  }

  async events(passId: string): Promise<LedgerEvent[]> {
    uuid(passId, 'passId');
    const { rows } = await this.db.query('SELECT * FROM ledger_events WHERE pass_id = $1 ORDER BY seq', [passId]);
    return rows.map(row => ({ seq: row.seq, passId: row.pass_id, kind: row.kind, payload: row.payload,
      createdAt: row.created_at.toISOString() }));
  }

  async enqueueJob(kind: string, payload: unknown,
    options: { dedupeKey?: string; delayMs?: number; maxAttempts?: number } = {}): Promise<Job> {
    key(kind, 'kind');
    const delay = options.delayMs ?? 0;
    const attempts = options.maxAttempts ?? 5;
    check(intIn(delay, 0, 31 * 86_400_000) && intIn(attempts, 1, 100), 'job options invalid');
    const { rows } = await this.db.query(`INSERT INTO jobs (kind, payload, dedupe_key, status, max_attempts, run_after)
      VALUES ($1, $2, $3, 'queued', $4, now() + $5 * interval '1 millisecond')
      ON CONFLICT (dedupe_key) DO UPDATE SET dedupe_key = jobs.dedupe_key RETURNING *`,
      [kind, JSON.stringify(payload ?? null), options.dedupeKey ?? null, attempts, delay]);
    return jobFrom(rows[0]);
  }

  /** Claims the next ready job (or one whose lease expired). Each claim counts as an attempt. */
  async claimJob(kinds: string[], leaseMs: number): Promise<Job | null> {
    check(Array.isArray(kinds) && kinds.length > 0, 'kinds required');
    check(intIn(leaseMs, 1, 3_600_000), 'leaseMs invalid');
    return transaction(this.db, async tx => {
      await tx.query(`UPDATE jobs SET status = 'dead', lease_token = NULL, updated_at = now(),
        last_error = coalesce(last_error, 'lease expired') WHERE kind = ANY($1) AND status = 'running'
        AND lease_until < now() AND attempts >= max_attempts`, [kinds]);
      const { rows } = await tx.query(`UPDATE jobs SET status = 'running', attempts = attempts + 1,
        lease_token = $3, lease_until = now() + $2 * interval '1 millisecond', updated_at = now()
        WHERE id = (SELECT id FROM jobs WHERE kind = ANY($1) AND ((status = 'queued' AND run_after <= now())
          OR (status = 'running' AND lease_until < now())) ORDER BY run_after, id
          FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`, [kinds, leaseMs, randomUUID()]);
      return rows[0] ? jobFrom(rows[0]) : null;
    });
  }

  async completeJob(jobId: string, leaseToken: string): Promise<void> {
    const { rowCount } = await this.db.query(`UPDATE jobs SET status = 'done', lease_token = NULL,
      lease_until = NULL, updated_at = now() WHERE id = $1 AND status = 'running' AND lease_token = $2 AND lease_until > now()`,
      [jobKey(jobId), uuid(leaseToken, 'leaseToken')]);
    if (!rowCount) fail('lease_lost', 'job lease no longer held');
  }

  async failJob(jobId: string, leaseToken: string, error: string, retryDelayMs = 1_000): Promise<Job> {
    check(intIn(retryDelayMs, 0, 86_400_000), 'retryDelayMs invalid');
    const { rows } = await this.db.query(`UPDATE jobs SET lease_token = NULL, lease_until = NULL,
      last_error = $3, updated_at = now(),
      status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'queued' END,
      run_after = now() + $4 * interval '1 millisecond'
      WHERE id = $1 AND status = 'running' AND lease_token = $2 AND lease_until > now() RETURNING *`,
      [jobKey(jobId), uuid(leaseToken, 'leaseToken'), String(error).slice(0, 2000), retryDelayMs]);
    return rows[0] ? jobFrom(rows[0]) : fail('lease_lost', 'job lease no longer held');
  }
}
