# Swipr

React + TypeScript + Tailwind + Vite PWA, with a separate Node API and worker,
Arkiv as the only database, Render static-site configuration and GCP Cloud Run deployment
tooling. The resolved product decisions are in [docs/BUILD-CONTRACT.md](docs/BUILD-CONTRACT.md).

## Run locally

Node 22.18+ is required. Run `npm ci`, then `npm run dev` (localhost:5173).
Run `npm test`, `npm run typecheck` and `npm run build` to verify.
For the production PWA, run `npm exec vite preview -- --port 4173` after building.
Service-worker caching is enabled in production builds only.

For the backend, copy `.env.example` to a gitignored `.env`, set `ARKIV_WRITER_ADDRESS`, then
run `npm run dev:stack`. This starts the website, API (8787) and worker (8788). Or use the
API/worker Docker composition in [docs/INFRASTRUCTURE.md](docs/INFRASTRUCTURE.md). There is
no SQL database: the API reads Arkiv, and only the worker writes, with `ARKIV_RELAYER_PK`.
`npm run doctor` checks configuration without printing secrets. Tests use an in-memory
Arkiv adapter and never touch live Arkiv.

## Implemented website

- Responsive portrait deck: pass, undo, ghost, horizontal swipe and vertical profile.
- Persistent free local ghosts, original start/size/expiry, removal and empty states.
- Trading-style and ghost-size preferences, Matches and account navigation.
- Copy Pass editing, local drafts, frozen review and permission acknowledgement.
- Clear unavailable wallet/quote/proof states; no invented activation or fills.
- Install manifest, local fonts/images, offline shell and offline status.

The permanently labeled design profiles are illustrative, not actual traders.
Ghost parameters are saved in this browser; performance replay awaits recorded
trades and quotes. Live trading, funding, login, matching, actual positions,
settlement and provider proofs are not connected in this milestone.

No funds move. Clearing site data removes local ghosts and drafts. Never put
secrets in VITE_ variables. `.env.example` lists integration settings.

## Backend and demo readiness

State persists in a durable Arkiv event journal. The worker submits one event per
transaction at an explicit account nonce; replay reconstructs pass budgets and job
claims. A separate optional maintenance account renews expiring history. Local tests
cover replay, concurrency, ambiguous acknowledgements and retention guards; funded
Rabdi write/confirmation/restart acceptance is still pending. No project writer key,
address or funding has been verified. The API verifies Privy access tokens and linked wallet ownership. Provider transports cover Flash quotes/signed order
relay, Base receipts/transfer decoding and Bee bytes; transport is not live trading.
The worker currently runs Base network probes. Pass activation and order submission
remain gated until the ENS matcher, provider signer and receipt verification exist.

The [demo checklist](docs/DEMO-CHECKLIST.md) tracks all functionality and evidence.
The [infrastructure runbook](docs/INFRASTRUCTURE.md) records local checks, deployment
commands and missing live gates. Target: `ethonline-476311`, `us-central1`; nothing
has been deployed or pushed, and no SQL instance exists. Read-only Rabdi chain/schema probes and an unsigned Flash quote succeeded; no funds moved.
See [the Arkiv storage contract](docs/ARKIV-STORAGE.md) for coordination and retention limits.
Portrait provenance and font licenses are in [docs/ASSETS.md](docs/ASSETS.md).
