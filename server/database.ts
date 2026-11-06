import pg from 'pg';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export const SCHEMA_VERSION = 1;
const MIGRATION_LOCK = 0x5717; // arbitrary advisory lock id for schema changes

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ledger_meta (
  id int PRIMARY KEY CHECK (id = 1),
  schema_version int NOT NULL
);
CREATE TABLE IF NOT EXISTS passes (
  id uuid PRIMARY KEY,
  wallet text NOT NULL CHECK (wallet ~ '^0x[0-9a-f]{40}$'),
  trader_id text NOT NULL,
  request_key text NOT NULL,
  terms jsonb NOT NULL,
  per_trade_micros bigint NOT NULL CHECK (per_trade_micros > 0),
  cap_micros bigint NOT NULL CHECK (cap_micros > 0),
  trade_count int NOT NULL CHECK (trade_count > 0),
  status text NOT NULL CHECK (status IN ('requested', 'accepted', 'active')),
  held_micros bigint NOT NULL DEFAULT 0 CHECK (held_micros >= 0),
  spent_micros bigint NOT NULL DEFAULT 0 CHECK (spent_micros >= 0),
  entries int NOT NULL DEFAULT 0 CHECK (entries >= 0),
  activated_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (wallet, request_key),
  CHECK (held_micros + spent_micros <= cap_micros),
  CHECK (entries <= trade_count)
);
CREATE INDEX IF NOT EXISTS passes_wallet ON passes (wallet, created_at);
CREATE TABLE IF NOT EXISTS chain_proofs (
  pass_id uuid NOT NULL REFERENCES passes (id),
  kind text NOT NULL CHECK (kind IN ('accept', 'activate')),
  chain_id bigint NOT NULL,
  tx_hash text NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  block_number bigint NOT NULL,
  proof jsonb NOT NULL,
  PRIMARY KEY (pass_id, kind),
  UNIQUE (kind, chain_id, tx_hash)
);
CREATE TABLE IF NOT EXISTS reservations (
  id uuid PRIMARY KEY,
  pass_id uuid NOT NULL REFERENCES passes (id),
  signal_id text NOT NULL,
  idempotency_key text NOT NULL,
  amount_micros bigint NOT NULL CHECK (amount_micros > 0),
  filled_micros bigint NOT NULL DEFAULT 0 CHECK (filled_micros >= 0),
  remaining_units numeric(78, 0) NOT NULL DEFAULT 0 CHECK (remaining_units >= 0),
  status text NOT NULL CHECK (status IN ('pending', 'settled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pass_id, idempotency_key),
  UNIQUE (pass_id, signal_id),
  CHECK (filled_micros <= amount_micros)
);
CREATE TABLE IF NOT EXISTS ledger_events (
  seq bigserial PRIMARY KEY,
  pass_id uuid NOT NULL REFERENCES passes (id),
  kind text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_events_pass ON ledger_events (pass_id, seq);
CREATE OR REPLACE FUNCTION ledger_events_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'ledger_events is append-only'; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS ledger_events_no_change ON ledger_events;
CREATE TRIGGER ledger_events_no_change BEFORE UPDATE OR DELETE ON ledger_events
  FOR EACH ROW EXECUTE FUNCTION ledger_events_immutable();
CREATE TABLE IF NOT EXISTS jobs (
  id bigserial PRIMARY KEY,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  dedupe_key text UNIQUE,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'done', 'dead')),
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL CHECK (max_attempts > 0),
  run_after timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_ready ON jobs (status, run_after);
`;

export async function openDatabase(connectionString: string, poolMax = 10): Promise<Db> {
  const pool = new pg.Pool({ connectionString, max: poolMax, connectionTimeoutMillis: 8000, statement_timeout: 15000, idle_in_transaction_session_timeout: 15000 });
  // Idle client errors (e.g. Cloud SQL failover) must not crash the process.
  pool.on('error', () => console.error('ledger_pool_connection_error'));
  try {
    await transaction(pool, async tx => {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
      const existing = await tx.query(`SELECT to_regclass('ledger_meta') AS t`);
      if (existing.rows[0].t) {
        const version = await tx.query('SELECT schema_version FROM ledger_meta WHERE id = 1');
        if ((version.rows[0]?.schema_version ?? 0) > SCHEMA_VERSION) {
          throw new Error('database schema is newer than this build');
        }
      }
      await tx.query(SCHEMA);
      await tx.query(`INSERT INTO ledger_meta (id, schema_version) VALUES (1, $1)
        ON CONFLICT (id) DO UPDATE SET schema_version = EXCLUDED.schema_version`, [SCHEMA_VERSION]);
    });
  } catch (error) {
    await pool.end();
    throw error;
  }
  return pool;
}

export async function transaction<T>(db: Db, work: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query('BEGIN');
    const result = await work(tx);
    await tx.query('COMMIT');
    return result;
  } catch (error) {
    await tx.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    tx.release();
  }
}
