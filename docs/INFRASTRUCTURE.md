# Swipr infrastructure and runbook

Status, 6 November 2026: **nothing here is deployed.** Arkiv is the only database: no
PostgreSQL, Cloud SQL, Redis or local side store, and no SQL instance was ever created.
The website is verified locally ([WEBSITE-VERIFICATION.md](WEBSITE-VERIFICATION.md)).
The Arkiv journal, replay ledger and separate-account renewal are implemented and
covered by local tests. Public Rabdi reads succeeded; no project writer address,
key or funding has been verified, and no funded journal write has occurred.
Execution stays blocked (no signing, no matcher).

## Topology

| Piece | Where | Runs | Talks to |
|---|---|---|---|
| Frontend (static Vite PWA, `dist/`) | Render static site (`infra/render.yaml`) | `npm ci && npm run build` | API via build-time `VITE_API_URL` |
| API | Cloud Run `swipr-api`, port 8787, SA `swipr-api` | `npm run api` | Arkiv, read only |
| Worker | Cloud Run `swipr-worker`, port 8788, SA `swipr-worker` | `npm run worker` | Arkiv, sole writer; providers in live mode |
| Store | Arkiv (SDK default: Rabdi testnet) | — | Durable event journal on stream `ARKIV_ENGINE_STREAM` |
| Secrets | Secret Manager → Cloud Run env | — | Never in the image, repo, logs or `VITE_*` |

GCP: `ethonline-476311`, `us-central1`. One image (`Dockerfile`); the worker runs `npm run worker`.

## Runtime contract

- `ARKIV_WRITER_ADDRESS` is the dedicated engine relayer: the one canonical writer. The API
  only reads entities owned by it; it never holds `ARKIV_RELAYER_PK`.
- The worker is the only process that writes. The host implements a durable Arkiv event
  journal with nonce fencing and a serialized single-flight writer. Job claims and
  lease expiries are events in that same journal. A competing writer (for example two worker revisions overlapping during
  a rollout) is rejected by the nonce fence; `--max-instances 1` does not prevent overlap.
- A confirmed read anchors at head minus (`ARKIV_CONFIRMATIONS` − 1), default two confirmations.
  Latest-only query pages must contain only rows created by that anchor, with stable
  writer nonce and canonical hash checks. See [ARKIV-STORAGE.md](ARKIV-STORAGE.md).
- Without `ARKIV_RELAYER_PK` the worker can still read and run probes, but cannot write.
- API and worker serve `/health` and `/ready`, with `/healthz` and `/readyz` aliases.
- CORS: only `ALLOWED_ORIGINS` (HTTPS when `NODE_ENV=production`, which the image sets).
- API drains on `SIGTERM` with a 9-second deadline. Worker stops beginning new cycles;
  an in-flight confirmation can exceed Cloud Run shutdown time, so restart must reconcile
  the event ID before any retry.

## Environment

| Variable | Used by | Secret | Notes |
|---|---|---|---|
| `VITE_API_URL`, `VITE_PRIVY_APP_ID` | web build | no | Render env, `sync: false`; public |
| `ARKIV_WRITER_ADDRESS` | api, worker | no | Required for the API; worker requires it to write |
| `ARKIV_RPC_URL` | api, worker | no | Optional; default is the SDK's Rabdi RPC. Keep keys out of it |
| `ARKIV_ACCESS_KEY` | api, worker | yes | Optional, even in live; public RPC is rate limited |
| `ARKIV_RELAYER_PK` | worker | yes | Must derive `ARKIV_WRITER_ADDRESS`; doctor checks the match |
| `ARKIV_MAINTAINER_PK` | worker | yes | Optional separate funded account for hourly permissionless renewal; never the writer |
| `ARKIV_ENGINE_STREAM`, `ARKIV_CONFIRMATIONS` | api, worker | no | Defaults `swipr-engine-v1`, `2` |
| `PORT`, `APP_MODE`, `ALLOWED_ORIGINS`, `NODE_ENV` | api, worker | no | Compose / deploy script (`WEB_ORIGIN` → `ALLOWED_ORIGINS`) |
| `BASE_RPC`, `SEPOLIA_RPC`, `FLASH_KEY_EXEC`, `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_VERIFICATION_KEY` | api, worker | yes | Required only in `live` |
| `PRIVY_KEY_QUORUM_ID`, `PRIVY_AUTHORIZATION_PRIVATE_KEY`, `BEE_URL`, `SWARM_BATCH_ID`, `BEE_GATEWAY_URL`, `BEE_GATEWAY_2_URL` | worker | yes | Signer keys never reach the API |

`infra/secrets.sh` is the single per-service secret list used by both GCP scripts.

## Local

```sh
cp .env.example .env            # set ARKIV_WRITER_ADDRESS; preview needs no provider values
docker compose -f infra/docker-compose.yml up --build
curl -fsS localhost:8787/readyz && curl -fsS localhost:8788/healthz
npm run dev                     # frontend on 127.0.0.1:5173
npm run doctor -- --role stack  # configured/missing only, never values
```

Compose runs only the API and worker on 127.0.0.1 and blanks both Arkiv private keys for the API.

## CI (`.github/workflows/ci.yml`)

Node 22: typecheck, unit/contract tests via the in-memory Arkiv test adapter (never
live), build, preview doctor with a placeholder writer, and an unpushed image build.
No database service; CI deploys nothing.

## Cloud deploy

`PROJECT_ID=ethonline-476311 scripts/provision-gcp.sh` prints the plan. With `--execute`
and `CONFIRM_PROJECT_ID` it enables Run, Cloud Build, Artifact Registry, Secret Manager and
IAM; creates the `swipr` Docker repository and the `swipr-api` and `swipr-worker` service
accounts; and grants each account `secretAccessor` on its own existing secrets only. It
creates no secrets, so no empty `swipr-arkiv-relayer-pk` exists before the key does.
Never reuse another app's Privy project or credentials.

```sh
PROJECT_ID=ethonline-476311 REGION=us-central1 WEB_ORIGIN=https://<render-site> \
API_SERVICE_ACCOUNT=swipr-api@ethonline-476311.iam.gserviceaccount.com \
WORKER_SERVICE_ACCOUNT=swipr-worker@ethonline-476311.iam.gserviceaccount.com \
ARKIV_WRITER_ADDRESS=0x… scripts/deploy-cloud-run.sh                  # dry run
CONFIRM_PROJECT_ID=ethonline-476311 … scripts/deploy-cloud-run.sh --execute
```

The API is public (auth per route). The worker is `--ingress internal`,
`--no-cpu-throttling`, min = max = 1. In `preview` absent secrets are skipped; in `live`
all are required except `ARKIV_ACCESS_KEY` and `ARKIV_MAINTAINER_PK`.
The maintenance key is optional for a short demo; ongoing operation needs renewal. Then create the Render site from
`infra/render.yaml`, set `VITE_API_URL` to the printed URL, rebuild, and record
`/health`, `/ready`, the Render URL and the deployed commit in the demo checklist.

## Evidence and current boundary

- Local Arkiv unit/contract tests, typecheck and frontend build are recorded in the
  storage contract. Doubles prove the adapter contract, not funded chain execution.
- Public Rabdi chain and schema-query probes succeeded (blocks 281542 and 281582).
  No project journal was initialized. Funded write/readback/restart acceptance needs
  a dedicated writer configured with tGLM, and long-running renewal a separate account.
- API without Arkiv configuration: `/health` 200 and `/ready` 503 verified locally on port 18787.
- Flash quote `289d8fb0-264b-4405-85c3-4104a9fbb82c` (`2026-11-06T06:53:03Z`, Base 8453): read only.
- `/api/passes` and `/api/orders` POST return 503 gates (no ENS matcher, signer or
  reconciler). Bee does not verify BMT. Docker image and compose are unverified.

## Rollback and incidents

- Cloud Run: `gcloud run services update-traffic <service> --to-revisions=<prev>=100`; Render: redeploy.
- Relayer key leak: stop workers, revoke signing access and disable the secret version.
  Preserve and verify history, outstanding holds and settlement baselines before a
  migration. Changing the writer address alone would reset history and is unsafe.
- Never mark a cash-out complete by hand (see [BUILD-CONTRACT.md](BUILD-CONTRACT.md)).

## Sources

- Arkiv batches (one transaction, all or nothing): https://docs.arkiv.network/writing/batches/
- Transaction `nonce` field (TxParams): https://docs.arkiv.network/typescript-sdk/api-reference/main/type-aliases/txparams/
- `getEntityNonce` (entity-minting nonce, not the transaction nonce): https://docs.arkiv.network/typescript-sdk/api-reference/main/type-aliases/publicarkivactions/
- Installed SDK 1.0.1 `src/actions/public/query.ts`: latest-only queries, no historical query option.
- Query `blockNumber` read at: https://docs.arkiv.network/typescript-sdk/api-reference/main/type-aliases/queryreturntype/ and https://docs.arkiv.network/querying/paginate/
- Rabdi network (chain 7794095, RPC): https://docs.arkiv.network/networks/rabdi/
- [Cloud Run known issues](https://docs.cloud.google.com/run/docs/known-issues), [Render static sites](https://render.com/docs/static-sites)
