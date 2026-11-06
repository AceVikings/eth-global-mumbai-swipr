#!/usr/bin/env bash
# Builds one image and deploys the Swipr API (read-only Arkiv) and worker (sole Arkiv writer).
# Dry run by default: prints the gcloud commands. Nothing is deployed unless
# --execute is passed AND CONFIRM_PROJECT_ID equals PROJECT_ID.
# Secret values are never read or printed; Cloud Run resolves them from Secret Manager.
set -euo pipefail
cd "$(dirname "$0")/.."
source infra/secrets.sh

EXECUTE=false
[[ "${1:-}" == "--execute" ]] && EXECUTE=true

missing=()
for name in PROJECT_ID REGION API_SERVICE_ACCOUNT WORKER_SERVICE_ACCOUNT WEB_ORIGIN ARKIV_WRITER_ADDRESS; do
  [[ -n "${!name:-}" ]] || missing+=("$name")
done
((${#missing[@]} == 0)) || { echo "Missing required variables: ${missing[*]} (see docs/INFRASTRUCTURE.md)" >&2; exit 2; }
node -e 'const u = new URL(process.argv[1]); if (u.protocol !== "https:" || u.origin !== process.argv[1]) process.exit(1)' "$WEB_ORIGIN" || { echo "WEB_ORIGIN must be a bare HTTPS origin" >&2; exit 2; }
[[ "$ARKIV_WRITER_ADDRESS" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "ARKIV_WRITER_ADDRESS must be a 0x address" >&2; exit 2; }
[[ "${ARKIV_CONFIRMATIONS:-2}" =~ ^[0-9]+$ ]] || { echo "ARKIV_CONFIRMATIONS must be an integer" >&2; exit 2; }
[[ "$API_SERVICE_ACCOUNT" != "$WORKER_SERVICE_ACCOUNT" ]] || { echo "API and worker need separate service accounts" >&2; exit 2; }

APP_MODE="${APP_MODE:-preview}"
REPOSITORY="${REPOSITORY:-swipr}"
TAG="${TAG:-$(git rev-parse --short HEAD)}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/backend:${TAG}"
ENV_VARS="APP_MODE=${APP_MODE},ALLOWED_ORIGINS=${WEB_ORIGIN},ARKIV_WRITER_ADDRESS=${ARKIV_WRITER_ADDRESS}"
ENV_VARS+=",ARKIV_ENGINE_STREAM=${ARKIV_ENGINE_STREAM:-swipr-engine-v1},ARKIV_CONFIRMATIONS=${ARKIV_CONFIRMATIONS:-2}"
# Unset means the SDK's default Rabdi RPC. Keep access keys out of this URL; use the secret.
[[ -z "${ARKIV_RPC_URL:-}" ]] || ENV_VARS+=",ARKIV_RPC_URL=${ARKIV_RPC_URL}"

# Provider secrets are required in live and skipped in preview when absent; optional ones never block.
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
    elif [[ "$APP_MODE" == live ]] && ! is_optional_secret "$name"; then
      echo "  secret ${name}: missing (${secret}); required in live" >&2
      return 1
    else
      echo "  secret ${name}: missing (${secret}); skipped" >&2
    fi
  done
  local IFS=,
  printf '%s' "${pairs[*]}"
}

run() { printf '+'; printf ' %q' "$@"; printf '\n'; if $EXECUTE; then "$@"; fi; }
if $EXECUTE && [[ "${CONFIRM_PROJECT_ID:-}" != "$PROJECT_ID" ]]; then
  echo "Refusing to deploy: set CONFIRM_PROJECT_ID=$PROJECT_ID after the target project is confirmed." >&2
  exit 3
fi
$EXECUTE || echo "DRY RUN (pass --execute with CONFIRM_PROJECT_ID to deploy)"

echo "Secret Manager names in ${PROJECT_ID} (values are never read):" >&2
api_secrets="$(secret_flags "${API_SECRETS[@]}")"
worker_secrets="$(secret_flags "${WORKER_SECRETS[@]}")"
secrets_flag() { if [[ -n "$1" ]]; then printf -- '--set-secrets=%s' "$1"; else printf -- '--clear-secrets'; fi; }
COMMON=(--project "$PROJECT_ID" --region "$REGION" --image "$IMAGE")

run gcloud builds submit --project "$PROJECT_ID" --region "$REGION" --tag "$IMAGE" .

# API: public ingress, auth per route; reads Arkiv only and never receives ARKIV_RELAYER_PK.
run gcloud run deploy swipr-api "${COMMON[@]}" --service-account "$API_SERVICE_ACCOUNT" \
  --port 8787 --allow-unauthenticated --max-instances 1 --concurrency 8 \
  --set-env-vars "$ENV_VARS" "$(secrets_flag "$api_secrets")"

# Worker: the only Arkiv writer, one always-on instance with no public traffic. Cloud Run can
# still run two revisions briefly during a rollout; the host's Arkiv nonce fence, not
# max-instances, is what rejects a competing writer.
run gcloud run deploy swipr-worker "${COMMON[@]}" --service-account "$WORKER_SERVICE_ACCOUNT" \
  --port 8788 --no-allow-unauthenticated --ingress internal \
  --no-cpu-throttling --min-instances 1 --max-instances 1 \
  --command npm --args run,worker \
  --set-env-vars "$ENV_VARS" "$(secrets_flag "$worker_secrets")"

if $EXECUTE; then
  url="$(gcloud run services describe swipr-api --project "$PROJECT_ID" --region "$REGION" --format 'value(status.url)')"
  echo "API URL (set as VITE_API_URL on Render): ${url}"
  echo "Next: verify ${url}/health and ${url}/ready before recording anything as live."
fi
