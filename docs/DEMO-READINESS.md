# Demo readiness — 6 November 2026

**NOT DEMO READY.** Removing sample data does not implement trading or prove live results.
The scope remains the complete [original demo plan](DEMO-PLAN.md), with every beat tracked
in [DEMO-CHECKLIST.md](DEMO-CHECKLIST.md). Do not shrink the demo to the website to call it done.

## No mock data contract

- The running website has no sample-mode switch, fictional directory, seeded profit rows,
  preview follows or design portraits. It requests real bot registrations and rankings.
- Legacy ghosts remain untouched under `swipr.ghosts.v1`. Live ghosts use v2;
  real legacy entries carry forward on first change, while the four old sample identities
  are excluded. An existing v2 list always takes precedence, including removals. Ghosts themselves are simulations by product design,
  not executed copies, and never contribute to rankings.
- Design studies and their portraits live under `design/leaderboards/` only.
  Unit tests may use doubles; their passing results never count as real fills.
- Unavailable data is not zero, an empty wallet, successful onboarding or an activated pass.
- `npm run check:bundle` rejects known preview markers and portraits in the emitted site.
  CI runs it after the production build. This is a regression check for the removed fixtures,
  not a general proof of the provenance of arbitrary API data.

## Repeatable preflight

Run `npm run build`, then `npm run demo:check` with the intended API origin in
`PUBLIC_API_URL` or `VITE_API_URL`. The latter command is read-only, prints no secret
values, forces live configuration validation, and exits nonzero if any required probe fails.
It checks the production artifact, API process, confirmed Arkiv journal, verified execution
capabilities, bot registrations, verified trader directory, and both ranking roles.
A healthy process alone does not pass. A green preflight alone also does not establish
full demo acceptance: all transaction proofs and rehearsals below are still required.

Observed local result: 7 preflight gates blocked. Process health and the fixture-free
production artifact pass; live config, Arkiv readiness, verified execution, real bot
onboarding, verified directory and trader/copier rankings do not pass. Doctor identifies
10 missing configuration values (Flash and Privy are configured; configured is not verified).

## Implementation sequence and acceptance

| Work | Current gap | Required evidence |
|---|---|---|
| Funded Arkiv runtime | No dedicated writer address/key or funding in local config | Confirmed write tx, entity read, worker restart and contiguous replay |
| Profiles and real history | Bot registration exists; human trader directory and verified position ingestion absent | Real owner registration, trusted notary/scorekeeper entities, chain-confirmed entry/exit receipts |
| Rankings and ghost replay | Ranking calculation exists; main process supplies no verified position reader; ghost results unavailable | Both role rankings recomputed from receipts, percentage and dollar sorts, Following filter; ghost replay with assumptions |
| Matching and pass activation | `/api/passes` submission returns `matcher_unavailable`; Matches cannot load confirmed copies | Trader acceptance, ENS pass mint, separate allowance/policy review, confirmed activation |
| Entry and exit execution | Order submission gated; worker runs Base probes only | Tap and auto entry, shared-price bounds, bracket IDs, cancel/reconcile, shared exit and outside-watch receipts |
| Breakup and settlement | No complete product job pipeline | Paused entries, canceled orders, reconciled attributed holdings, cash-out receipt, fee transfer or actual waiver |
| Agent Charter and open notary | ENS text and fill sealing tools unavailable | Guardian halt, mined unauthorized mandate revert, real agent fill and copier skip, opted-in external fill |
| Social and bot writes | Signed commands and journal stores implemented, funded runtime unverified | Real Google login, linked-wallet signatures, Arkiv registration/follow/unfollow, REST/MCP proposal; proposal never ranked as fill |
| Swarm, League and reach | Byte transport only; BMT, archive recovery, snapshots and publishers absent | Both gateways, BMT app/archive proof, keyless real directory/ghost reads, stats verification, League/reach reads |
| Deployment and rehearsal | No Swipr service found in the selected Cloud Run project/region | Render URL, API/worker revisions, healthy journal readiness, real participant history, five <=2:45 rehearsals |

The project check was metadata-only: `ethonline-476311`, `us-central1`; no `swipr-api`
or `swipr-worker` service and no `swipr-*` Secret Manager entries were listed.
Unrelated projects' credentials were not read or reused.

## Inputs still required

A dedicated funded Arkiv writer (and separate maintainer for retention), Base/Sepolia
RPCs and transaction funds, verified signer-policy configuration, Bee/postage/gateways,
and real trader/copier rehearsal wallets. Provide local credential file paths or dedicated
Secret Manager names, never paste secrets into chat. Those inputs are necessary but do
not replace the missing implementations above. Actual historical trading takes real elapsed
time; the plan's approximately 22-hour track record cannot be fabricated or accelerated.

## Verification boundaries

Local tests use doubles and static data. Browser inspection of the new live-only populated
leaderboard is blocked by the missing verified history source and unavailable browser host;
see `design-qa.md`. The earlier mobile screenshot is historical preview-layout evidence.

Code review: skipped (ce-code-review unavailable) — native review dispatch is unavailable
and the installed subagent bridge rejects this repository. A separate local Claude CLI
context performed a bounded read-only audit; this is not a completed ce-code-review receipt.
Its verified findings are reflected in the implementation sequence above. A second
diff review caught the legacy-ghost migration and empty-avatar issues; those were fixed
and the follow-up confirmed the storage migration and labeling corrections. Full repository
security review and the existing dependency/rate-limit findings remain open in the checklist.
