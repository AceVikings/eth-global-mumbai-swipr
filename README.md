# Swipr

React + TypeScript + Tailwind + Vite PWA, with a separate Node API and worker,
PostgreSQL ledger, Render static-site configuration and GCP Cloud Run deployment tooling. The resolved
product decisions are in [docs/BUILD-CONTRACT.md](docs/BUILD-CONTRACT.md).

## Run locally

Node 22.18+ is required. Run `npm ci`, then `npm run dev` (localhost:5173).
Run `npm test`, `npm run typecheck` and `npm run build` to verify.
For the production PWA, run `npm exec vite preview -- --port 4173` after building.
Service-worker caching is enabled in production builds only.

For the backend, set `DATABASE_URL` in a gitignored `.env`, then run `npm run dev:stack`.
This starts the website, API (8787), and worker (8788). Or use the PostgreSQL/API/worker
Docker composition described in [docs/INFRASTRUCTURE.md](docs/INFRASTRUCTURE.md).
`npm run doctor` checks configuration without printing secrets. Ledger integration
tests use `LEDGER_TEST_DATABASE_URL` (throwaway database only) or create a temporary
local PostgreSQL cluster when the binaries are available.

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

The durable ledger validates frozen terms, reserves cumulative USDC budgets under
row locks, reconciles partial entries, and keeps an append-only journal. Durable
jobs use expiring leases and fencing tokens. The API verifies Privy access tokens
and linked wallet ownership. Provider transports cover Flash quotes/signed order
relay, Base receipts/transfer decoding and Bee bytes; transport is not live trading.
The worker currently runs Base network probes. Pass activation and order submission
remain gated until the ENS matcher, provider signer and receipt verification exist.

The [demo checklist](docs/DEMO-CHECKLIST.md) tracks all functionality and evidence.
The [infrastructure runbook](docs/INFRASTRUCTURE.md) records local checks, deployment
commands and missing live gates. Target: `ethonline-476311`, `us-central1`; nothing
has been deployed or pushed. The only live provider check so far is an unsigned
Flash quote; no funds moved.
Portrait provenance and font licenses are in [docs/ASSETS.md](docs/ASSETS.md).
