# Swipr deployment

Production branch: `main`. Implementation commits stay below 1,000 added + removed
lines and are fast-forwarded into main without squashing their history.

## GitHub Actions → Cloud Run

`.github/workflows/ci.yml` runs Node 22 typechecking, tests, Vite build, the emitted
fixture check and the offline config doctor before the backend image job. Pull requests
and other branches build but cannot deploy. A main push or main workflow dispatch can
release when repository variable `SWIPR_DEPLOY_ENABLED=true`.

Authentication is GitHub OIDC → GCP Workload Identity Federation → the dedicated
`swipr-deployer` account. No GCP JSON key or application credential is stored in GitHub.
Trust is restricted to repository ID 1447889005, owner ID 51465755, `refs/heads/main`,
and this repository's `.github/workflows/ci.yml` on main.

GitHub secrets:

- `GCP_WORKLOAD_IDENTITY_PROVIDER`
- `GCP_DEPLOY_SERVICE_ACCOUNT`

GitHub variables:

- `GCP_PROJECT_ID=ethonline-476311`
- `GCP_REGION=us-central1`
- `SWIPR_WEB_ORIGIN=https://swipr-web.onrender.com`
- `SWIPR_DEPLOY_ENABLED=true` after initial bootstrap and service IAM grants

Images are tagged with the complete source commit in the `swipr` Artifact Registry
repository and resolved to a SHA-256 digest before rollout.
`scripts/release-backend.sh` preserves existing runtime secrets/configuration,
checks each runtime service account, updates worker then API, and directs traffic to the
new revisions. CI probes API liveness and runtime, anonymous worker denial and authenticated
worker liveness. Deployment success does not imply `/ready` or trading readiness.

The deployer has Artifact Registry write access on the Swipr repository, deployment
access on the two Swipr services, and `serviceAccountUser` on their two runtime identities.
It has no application-secret value access. The API runtime can read only its dedicated
secrets and invoke the worker. The worker is protected by Cloud Run IAM.

## Runtime bootstrap and configuration changes

Run `scripts/provision-gcp.sh --execute` with the confirmed project variables first.
After building/pushing the desired commit image, `scripts/bootstrap-cloud-run.sh` configures
the runtime services and binds only dedicated `swipr-*` secrets that actually exist.
It never invents missing Arkiv credentials or replaces them with a local database.

Required bootstrap inputs: `PROJECT_ID`, `REGION`, `IMAGE_URI`, `WEB_ORIGIN`;
`ARKIV_WRITER_ADDRESS` remains empty until the real funded writer is available.
Missing storage keeps API/worker liveness available while readiness and writes are refused.
The worker scales to zero while unconfigured. Rerun bootstrap with the actual writer and
relayer secret to enable its always-on background processing (minimum one instance and
CPU outside requests). Secret values go to Secret Manager via stdin, never shell arguments,
workflow YAML, Git, build archives or VITE variables.

Existing local Swipr credentials were copied into dedicated Secret Manager entries:
`swipr-privy-app-id`, `swipr-privy-app-secret`, `swipr-privy-verification-key`, and
`swipr-flash-key-exec`. Their exact local dotenv values were checked without printing them.
This does not pass the Google login or trading acceptance gates.

## Render frontend

Static site `swipr-web`: <https://swipr-web.onrender.com>.
Service ID: `srv-dbmp4i67bikc73blahmg`.
The linked private repository remains private; Render's existing GitHub connection builds main.
Build: `npm ci && npm run build && npm run check:bundle`; publish directory: `dist`.
Only `NODE_VERSION`, `VITE_API_URL` and the public `VITE_PRIVY_APP_ID` go into its build.
`/sw.js` and `/index.html` use `Cache-Control: no-cache`; SPA fallback rewrites to index.
`infra/render.yaml` documents the equivalent service configuration.
After bootstrap, auto-deploy is set to `checksPass` so Render follows successful main checks.

## Remaining product gates

See [DEMO-READINESS.md](DEMO-READINESS.md) and the full [DEMO-CHECKLIST.md](DEMO-CHECKLIST.md).
Hosting is separate from funded Arkiv, pass matching, verified history, order execution,
signer policies and Swarm proofs. Add the Render origin to the dedicated Privy app's allowed
origins and verify real Google sign-in; do not infer this from an installed frontend SDK.
