# Arkiv is the project database

User decision, 6 November 2026: Arkiv stores all durable application data. No SQL,
Redis or local persistence service sits behind the API or worker. Browser-local
anonymous ghosts remain a convenience until login; they are not an authoritative
execution ledger. ENS and Flash retain their protocol state, secrets stay in
Secret Manager/Privy, and large artifacts and archives stay on Swarm.

## Product records and engine coordination

The research project's 19 schemas remain the product record contract: directory,
trades, signals, copies, follows, ghosts, exits, settlements, preferences, swipes,
audits, stats snapshots, opt-ins, referrals, archives, releases, League and entries.
User-owned follow/copy indexes are not trusted to reset execution budgets.

`swipr.engine-event.v1` is an additional operational schema. Each event carries
`project=swipr-mumbai26`, stream, revision, event ID and a JSON command in a bytes
attribute. It records frozen pass terms, reservations, cumulative reconciliation
and job claims/results. These records belong to a dedicated engine writer. They
are public: do not put credentials, signed orders, private theses or auth tokens
in them. The domain rejects secret-like payloads; this is not an encryption system.

The API gets a read-only client and no relayer key. The worker serializes commands
and writes one engine event per transaction with the SDK's atomic batch API. User
wallets, notary and scorekeeper retain their separate product-schema roles. The
engine account must never send unrelated transactions or write another stream.

## Why concurrent writers cannot spend the same budget

Arkiv SDK 1.0.1 queries read the latest block, and offset pagination is not a
snapshot. An atomic batch alone does not provide a SQL-style compare-and-swap.
The adapter therefore uses the dedicated account's **transaction nonce**, not its
entity-minting nonce, as the revision fence:

1. Choose a confirmed block (two confirmations by default) and read the writer's
   transaction nonce there. A pending or more recent writer transaction blocks new
   commands until reconciliation.
2. Read all engine events in revision order. Check project/stream/creator, owner,
   actual readonly flag, expiry, contiguous revisions and event-body/index agreement.
3. Recheck the canonical anchor hash, latest account nonce and pending nonce. A
   changed nonce or missing history rejects the read; a torn read cannot authorize
   a budget reservation.
4. Replay commands and validate the next reservation against held plus spent USDC
   micros and the trade-count cap. Submit at exactly that observed transaction nonce.
5. Wait for confirmation and read back the exact event. Competing stale writers
   cannot both mine different transactions at the same account nonce.

The in-process queue is only an optimization. Cloud Run can overlap revisions;
max-instances=1 does not establish an exclusive distributed writer.

An uncertain broadcast is never automatically resent or treated as unfilled.
Re-read by the operation's idempotency key; an existing reservation continues to
hold its budget until a trusted reconciler confirms a terminal result.

## Expiry, gaps and recovery

Engine events use readonly + permissionlessExtension and a 180-day lifetime.
Readonly prevents attribute changes; it does **not** remove the owner's ability to
delete an entity. Deletion, expiry, missing events or an unrelated/reverted engine
transaction causes a sequence/nonce mismatch, and the adapter stops writes.
It never treats missing history as a new empty budget.

The worker scans hourly and on startup with `ARKIV_MAINTAINER_PK`, a separate
account. It extends records within 30 days of expiry, in batches of ten, without
consuming the engine nonce. Missing configuration is a doctor warning. Reads stop
within one day of expiry; they also reject a confirmed chain clock more than 30
seconds from local time. Funded renewal remains unverified. Swarm archive/recovery
is still required for recovery after deletion or expiry.
A reverted engine transaction also needs an explicit, independently verified recovery
procedure; automatic gap repair is not implemented. A relayer-key rotation must
preserve and verify old pass budgets and settlement baselines before enabling a
new stream. Merely changing the writer address is not a safe migration.

## Verification boundary

Verification: 101 tests in 10 files pass, TypeScript checks and Vite production build
pass, and the production dependency audit reports zero vulnerabilities.

Unit tests use explicitly named test doubles for nonce fencing, replay, concurrency,
partial fills, lost acknowledgements, restart and stale leases. There is no runtime
fallback to those doubles. Public Rabdi chain and schema-query reads succeeded on
6 November 2026 (blocks 281542 and 281582; query returned no engine entities).
No project database or funded writer transaction was initialized by those probes.
Live write/confirmation/restart tests need the configured engine key and tGLM.

Financial execution remains gated: the host still needs to verify terminal venue
receipts before releasing holds, recheck pass expiry at signing/broadcast, and
check a job lease after its claim confirms. Chain event timestamps authorize the
reducer transition, not a future financial transaction. No trade executor may use
an old reservation or lease as perpetual permission. Full replay is intentionally
conservative and can make readiness unavailable during pending writes; scaling and
checkpointed recovery remain later gates.

References: [atomic batches](https://docs.arkiv.network/writing/batches/),
[transaction parameters](https://docs.arkiv.network/writing/create/#set-transaction-fields),
and SDK 1.0.1 `query.ts`, `executeBatch.ts`, `getEntityNonce.ts`, `flags.ts`.
