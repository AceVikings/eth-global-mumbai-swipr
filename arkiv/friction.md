# Arkiv feedback from the Swipr build

Scope: SDK **1.0.1**, Rabdi. These notes describe implemented workarounds and reproducible local regressions. They do not claim upstream issues were filed or that every proposal in the research notes was encountered in this build.

## 1. Structured profiles outgrow string attributes

**Expected:** a straightforward way to persist a complete profile and social list.

**Observed:** indexed text is limited to 128 UTF-8 bytes. A normal biography plus image reference or a growing following list does not fit as one string attribute.

**Workaround:** indexed short fields for queries, and JSON in `bytes` attributes. The same schema helper is used in the frontend and backend.

**Reproduce:** `npm test --prefix backend -- contracts/wallet-profile.test.ts`. It verifies profiles/following lists beyond the text limit and the bytes encoding. Inspect [schema helper](../backend/contracts/wallet-profile.ts).

**Request:** an application-profile/social-list example that demonstrates the string/bytes distinction and shows how to decode bytes in a query result.

## 2. A confirmed write and a current query index are different states

**Expected:** after confirming a write, a read immediately reflects the new state.

**Handled condition:** the app must account for a query index behind a confirmed transaction/anchor. Seats poll after confirmation; operational history rejects a lagging index instead of reconstructing a stale budget.

**Reproduce:** `npm test --prefix backend -- arkiv-journal.test.ts`, including the lagging-index and nonce-change cases. These use controlled fixtures to exercise the condition; they are not a claim of a current public-node incident.

**Request:** a standard SDK helper to wait for a query's indexed block to reach a confirmed receipt, with a visible pending state and deadline.

## 3. Pagination needs an application consistency boundary

**Expected:** reading a multi-page execution journal gives one coherent history.

**Handled condition:** the writer nonce can change between pages, and missing, expired or wrong-authority records cannot safely reconstruct reserved funds.

**Workaround:** verify the writer nonce around pagination, consecutive revisions and native authority/flags. Fail closed when the read is incomplete; preserve ambiguous submission holds. Per-writer appends are serialized.

**Reproduce:** the pagination, missing-revision and concurrent-journal cases in [arkiv-journal.test.ts](../backend/arkiv-journal.test.ts).

**Request:** explicit documentation of query snapshot guarantees and guidance for a stable multi-page read. The workaround is application sequencing, not a claim of multi-writer consensus.

## 4. Ownership and readonly need different explanations

**Potential misunderstanding:** readonly is easily read as permanent or undeletable.

**Our design:** readonly join terms cannot be edited, but their owner can delete the record. Service events are owned by the service, not by users. We do not describe those events as an independently permanent history.

**Request:** a compact permissions matrix covering patch, delete, extend and ownership changes for each flag combination, with UI examples. This distinction matters directly to Swipr's account deletion wording.

## 5. Access keys should stay out of wallet-visible RPC configuration

Swipr keeps the service access key in backend configuration. An authenticated allowlisted read proxy supplies the wallet's required RPC reads; signing and broadcasting remain with the user. [RPC adapter](../backend/arkiv-rpc.ts) limits methods and response size.

**Request:** a first-party browser/embedded-wallet recipe for sponsored writes that separates RPC authentication, gas funding, wallet authorization and broadcasting. These are separate steps, not interchangeable forms of sponsorship.

## What worked well

Native ownership, typed schema values and the public query endpoint fit a wallet-owned directory well. The exact README query returned three rehearsal profiles with the expected native owner on 2026-11-07. [Schema](schema.md), [why Arkiv](why-arkiv.md) and [Swarm feedback](swarm.md#friction) give the surrounding design.
