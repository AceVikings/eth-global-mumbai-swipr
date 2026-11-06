#!/usr/bin/env bash
# Builds one image and deploys the Swipr API and worker to Cloud Run.
# Dry run by default: prints the gcloud commands. Nothing is deployed unless
# --execute is passed AND CONFIRM_PROJECT_ID equals PROJECT_ID.
# Secret values are never read or printed; Cloud Run resolves them from Secret Manager.
set -euo pipefail

EXECUTE=false
[[ "${1:-}" == "--execute" ]] && EXECUTE=true

missing=()
for name in PROJECT_ID REGION SERVICE_ACCOUNT CLOUD_SQL_CONNECTION WEB_ORIGIN; do
  [[ -n "${!name:-}" ]] || missing+=("$name")
done
if ((${#missing[@]})); then
  echo "Missing required variables: ${missing[*]}" >&2
  echo "Example: PROJECT_ID=… REGION=… SERVICE_ACCOUNT=…@….iam.gserviceaccount.com \\" >&2
  echo "  CLOUD_SQL_CONNECTION=project:region:instance WEB_ORIGIN=https://<render-site> $0" >&2
  exit 2
fi
node -e 'const u = new URL(process.argv[1]); if (u.protocol !== "https:" || u.origin !== process.argv[1]) process.exit(1)' "$WEB_ORIGIN" || { echo "WEB_ORIGIN must be a bare HTTPS origin" >&2; exit 2; }

APP_MODE="${APP_MODE:-preview}"
REPOSITORY="${REPOSITORY:-swipr}"
SECRET_PREFIX="${SECRET_PREFIX:-swipr-}"
TAG="${TAG:-$(git rev-parse --short HEAD)}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/backend:${TAG}"

# Env var -> Secret Manager secret "<prefix><lower-kebab name>", version latest.
API_SECRETS=(DATABASE_URL PRIVY_APP_ID BASE_RPC SEPOLIA_RPC FLASH_KEY_EXEC PRIVY_APP_SECRET PRIVY_VERIFICATION_KEY
  ARKIV_ACCESS_KEY)
WORKER_SECRETS=("${API_SECRETS[@]}" PRIVY_KEY_QUORUM_ID PRIVY_AUTHORIZATION_PRIVATE_KEY
  ARKIV_RELAYER_PK BEE_URL SWARM_BATCH_ID BEE_GATEWAY_URL BEE_GATEWAY_2_URL)

secret_name() { printf '%s%s' "$SECRET_PREFIX" "$(tr '[:upper:]_' '[:lower:]-' <<<"$1")"; }

# Only DATABASE_URL is mandatory; provider secrets are attached when they exist.
secret_flags() {
  local pairs=() name secret
  for name in "$@"; do
    secret="$(secret_name "$name")"
    if ! $EXECUTE; then
      pairs+=("${name}=${secret}:latest")
      echo "  secret ${name}: ${secret} (not checked in dry run)" >&2
    elif gcloud secrets describe "$secret" --project "$PROJECT_ID" >/dev/null 2>&1; then
      pairs+=("${name}=${secret}:latest")
      echo "  secret ${name}: configured" >&2
    elif [[ "$name" == DATABASE_URL || "$APP_MODE" == live ]]; then
      echo "  secret ${name}: missing (${secret}); required" >&2
      return 1
    else
      echo "  secret ${name}: missing (${secret}); skipped in preview" >&2
    fi
  done
  local IFS=,
  printf '%s' "${pairs[*]}"
}

run() {
  printf '+'; printf ' %q' "$@"; printf '\n'
  if $EXECUTE; then "$@"; fi
}

if $EXECUTE && [[ "${CONFIRM_PROJECT_ID:-}" != "$PROJECT_ID" ]]; then
  echo "Refusing to deploy: set CONFIRM_PROJECT_ID=$PROJECT_ID after the target project is confirmed." >&2
  exit 3
fi
$EXECUTE || echo "DRY RUN (pass --execute with CONFIRM_PROJECT_ID to deploy)"

echo "Secret Manager names in ${PROJECT_ID} (values are never read):" >&2
api_secrets="$(secret_flags "${API_SECRETS[@]}")"
worker_secrets="$(secret_flags "${WORKER_SECRETS[@]}")"

COMMON=(--project "$PROJECT_ID" --region "$REGION" --image "$IMAGE"
  --service-account "$SERVICE_ACCOUNT" --add-cloudsql-instances "$CLOUD_SQL_CONNECTION")

run gcloud builds submit --project "$PROJECT_ID" --region "$REGION" --tag "$IMAGE" .

# API: public ingress; authentication is enforced per route by the app.
run gcloud run deploy swipr-api "${COMMON[@]}" \
  --port 8787 --allow-unauthenticated --max-instances 1 --concurrency 8 \
  --set-env-vars "APP_MODE=${APP_MODE},ALLOWED_ORIGINS=${WEB_ORIGIN}" \
  --set-secrets "$api_secrets"

# Worker: one always-on instance; jobs are leased from PostgreSQL, so a restart resumes.
# It serves /healthz on PORT for Cloud Run and accepts no public traffic.
run gcloud run deploy swipr-worker "${COMMON[@]}" \
  --port 8788 --no-allow-unauthenticated --ingress internal \
  --no-cpu-throttling --min-instances 1 --max-instances 1 \
  --command npm --args run,worker \
  --set-env-vars "APP_MODE=${APP_MODE},ALLOWED_ORIGINS=${WEB_ORIGIN}" \
  --set-secrets "$worker_secrets"

if $EXECUTE; then
  url="$(gcloud run services describe swipr-api --project "$PROJECT_ID" --region "$REGION" --format 'value(status.url)')"
  echo "API URL (set as VITE_API_URL on Render): ${url}"
  echo "Next: verify ${url}/health and ${url}/ready before recording anything as live."
fi
