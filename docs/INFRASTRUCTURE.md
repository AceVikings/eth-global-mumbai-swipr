# Swipr infrastructure and runbook

Status, 6 November 2026: **nothing here is deployed.** The website is verified
locally ([WEBSITE-VERIFICATION.md](WEBSITE-VERIFICATION.md)). The API, worker, PostgreSQL ledger and provider transports are implemented and locally tested.
Render and Cloud Run configuration is written; remote services are not deployed.
Live provider integrations are blocked on credentials and funds. Remote URLs remain unverified until deployment and external probes succeed.

## Topology

| Piece | Where | Runs | Talks to |
|---|---|---|---|
| Frontend (static Vite PWA, `dist/`) | Render static site (`infra/render.yaml`) | `npm ci && npm run build` | API via build-time `VITE_API_URL` |
| API | Cloud Run `swipr-api`, port 8787 | `npm run api` | PostgreSQL; public ingress, auth per route |
| Worker | Cloud Run `swipr-worker`, port 8788 | `npm run worker` | PostgreSQL leases; providers in live mode |
| Ledger | Cloud SQL for PostgreSQL 16 | — | Unix socket `/cloudsql/<CLOUD_SQL_CONNECTION>` |
| Secrets | Secret Manager → Cloud Run env | — | Never in the image, repo, logs or `VITE_*` |

Both backend processes use the same image (`Dockerfile`, Node 22, multi-stage
`npm ci` → `npm run build`). The image's default command is the API; the worker
overrides it with `npm run worker`.

## Runtime contract

- npm scripts `api`, `worker`, `doctor` and `dev:stack` (present; run TypeScript via tsx,
  so the runtime image keeps dev dependencies).
- Both processes read `DATABASE_URL` (PostgreSQL via `pg`, async), `PORT`, `APP_MODE`
  (`preview` default, `live` only after the live gates pass).
- API serves `GET /health` (process up) and `GET /ready` (database reachable).
  Container-local `/healthz` and `/readyz` aliases are also available.
  The worker serves the same routes on its own `PORT`.
- API allows CORS only from `ALLOWED_ORIGINS` (the Render site URL; HTTPS required
  when `NODE_ENV=production`, which the image sets). Compose sets `development`.
- Worker jobs are durable PostgreSQL rows claimed with an expiring lease
  (e.g. `FOR UPDATE SKIP LOCKED` + `lease_until`); leases fence stale workers. External
  financial effects still require provider idempotency and receipt reconciliation before enabling execution. Migrations are idempotent and run
  before either process reports ready.
- Exit on `SIGTERM` within 10 s: stop leasing, finish or release current leases.

## Environment

| Variable | Used by | Secret | Notes |
|---|---|---|---|
| `VITE_API_URL`, `VITE_PRIVY_APP_ID` | web build | no | Render env, `sync: false`; public by design |
| `DATABASE_URL` | api, worker | yes | Local: compose; Cloud: `swipr-database-url` |
| `PORT`, `APP_MODE`, `ALLOWED_ORIGINS`, `NODE_ENV` | api, worker | no | Set by compose / deploy script (`WEB_ORIGIN` → `ALLOWED_ORIGINS`) |
| `BASE_RPC`, `SEPOLIA_RPC`, `FLASH_KEY_EXEC`, `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_VERIFICATION_KEY`, `ARKIV_ACCESS_KEY` | api, worker | yes | Required only in `live` |
| `PRIVY_KEY_QUORUM_ID`, `PRIVY_AUTHORIZATION_PRIVATE_KEY`, `ARKIV_RELAYER_PK`, `BEE_URL`, `SWARM_BATCH_ID`, `BEE_GATEWAY_URL`, `BEE_GATEWAY_2_URL` | worker | yes | Signer and relayer keys never reach the API |

Never prefix a secret with `VITE_`; the doctor fails if one is.

## Local

```sh
cp .env.example .env            # required by compose; preview needs no provider values
docker compose -f infra/docker-compose.yml up --build
curl -fsS localhost:8787/readyz && curl -fsS localhost:8788/healthz
npm run dev                     # frontend on 127.0.0.1:5173
npm run doctor -- --role stack  # configured/missing only, never values
```

Compose starts `postgres:16-alpine` first; API and worker wait for it to be
healthy, restart `unless-stopped`, and bind to 127.0.0.1 only. The database
password is a local-only default (`LOCAL_POSTGRES_PASSWORD` overrides it).
Reset with `docker compose -f infra/docker-compose.yml down -v`.

## CI (`.github/workflows/ci.yml`)

Node 22, `npm ci`, typecheck, test, build and the doctor, with a PostgreSQL 16
service and a throwaway `DATABASE_URL` for integration tests. A second job
builds the Docker image without pushing it. CI deploys nothing.

## Cloud deploy

Target inspected: `ethonline-476311`, region `us-central1`. Existing Cloud Run services
use this region. Cloud SQL Admin API is disabled; no Swipr-specific service account
or secrets exist. No existing application secrets were read or reused.

`PROJECT_ID=ethonline-476311 scripts/provision-gcp.sh` prints the bootstrap plan.
Adding `--execute` with `CONFIRM_PROJECT_ID` provisions isolated `swipr-*` resources:
Artifact Registry, a PostgreSQL 16 Cloud SQL instance, database/user, runtime service
account and `swipr-database-url`. Passwords are generated, stored through stdin and
passed in a private temporary flags file; values are not logged. Existing users
without their saved secret require explicit recovery; passwords are never silently reset.
The instance uses a small shared-core tier, 10GB initial storage capped at 20GB,
backups/PITR and deletion protection. These resources are billable when created.

Provider secrets are separate, named `swipr-<lower-kebab>` and granted individually
to the runtime account. Do not reuse another app's Privy project or secrets.
The socket URL is `postgresql://USER:PASS@localhost/DB?host=/cloudsql/<CLOUD_SQL_CONNECTION>`.
The same runtime identity currently runs API and worker; split identities and secret
IAM before deploying a signing worker that needs stronger separation.

```sh
PROJECT_ID=… REGION=… SERVICE_ACCOUNT=… CLOUD_SQL_CONNECTION=… \
WEB_ORIGIN=https://<render-site> scripts/deploy-cloud-run.sh            # dry run
CONFIRM_PROJECT_ID=<same> … scripts/deploy-cloud-run.sh --execute       # real
```

The script builds via Cloud Build, deploys `swipr-api` (public, auth per route)
and `swipr-worker` (`--ingress internal`, `--no-cpu-throttling`, min = max = 1).
In `preview` it skips absent provider secrets; in `live` every one is required.
It prints secret names and configured/missing, never values.

Then: create the Render site from `infra/render.yaml` (Blueprint path), set
`VITE_API_URL` to the printed API URL, rebuild, and record in the demo checklist:
`/health`, `/ready`, the Render URL loading the deck, and the commit deployed.

## Local evidence and current boundary

- 83 tests passed, including a real throwaway PostgreSQL cluster: concurrent budget
  limits, partial reconciliation, duplicate intents, restart persistence, immutable
  journal, expired/reclaimed worker leases and auth/provider boundaries.
- API `http://127.0.0.1:8787/readyz` returned database schema 1 healthy; worker
  `http://127.0.0.1:8788/readyz` returned a current heartbeat.
- Flash `/quote` returned quote `289d8fb0-264b-4405-85c3-4104a9fbb82c` at
  `2026-11-06T06:53:03Z`, Base chain 8453 and the expected Flash domain. Read only:
  no signature or order submission. Key remained server-side. A subsequent quote
  exposed Flash's default far-future deadline; the signing validator blocks it. The
  API returns only a quote summary until a verified vault and bounded deadline exist.
- Docker daemon is stopped, so image/runtime composition is not yet verified.
- `/api/runtime` reports configured/unverified services. `/api/traders` stays empty
  until an independently verified Arkiv reader exists. Private endpoints verify
  Privy ES256 tokens and resolve linked wallets server-side.
- `/api/passes` POST and `/api/orders` POST return explicit 503 gates: there is no
  verified ENS matcher or execution reconciler yet. Nothing activates from browser
  assertions. The worker currently executes Base network probes only; mirror,
  watch, notary, scorekeeper, matcher and cash-out handlers remain checklist work.
- Completed probe jobs currently remain in PostgreSQL; add probe-only retention before long-running operation.
- Bee transport does not implement BMT verification and never reports it verified.

## Rollback and incidents

- Cloud Run: `gcloud run services update-traffic swipr-api --to-revisions=<prev>=100`
  (same for the worker). Render: redeploy the previous commit.
- Suspected key leak: disable the Secret Manager version, rotate at the provider,
  redeploy; revoke the Privy signer if the authorization key is affected.
- Worker stuck: leases expire and are reclaimed; never mark a cash-out complete
  by hand (see [BUILD-CONTRACT.md](BUILD-CONTRACT.md)).

Sources checked for the deployment contract: [Cloud Run known issues](https://docs.cloud.google.com/run/docs/known-issues),
[Cloud SQL connections](https://docs.cloud.google.com/sql/docs/postgres/connect-run),
[Render static sites](https://render.com/docs/static-sites) and
[Privy access-token verification](https://docs.privy.io/authentication/user-authentication/access-tokens).
