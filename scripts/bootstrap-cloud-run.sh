#!/usr/bin/env bash
# Explicit initial/runtime configuration. Missing product secrets are omitted, never replaced.
# scripts/provision-gcp.sh must run first. CI subsequently rolls out images without changing secrets.
set -euo pipefail
cd "$(dirname "$0")/.."
source infra/secrets.sh
: "${PROJECT_ID:?}" "${REGION:?}" "${IMAGE_URI:?}" "${WEB_ORIGIN:?}"
[[ "$IMAGE_URI" == "${REGION}-docker.pkg.dev/${PROJECT_ID}/swipr/backend:"* ]] || exit 2
node -e 'const u=new URL(process.argv[1]); if(u.protocol!=="https:"||u.origin!==process.argv[1])process.exit(1)' "$WEB_ORIGIN"
secret_flags() {
  local name secret pairs=()
  for name in "$@"; do
    secret="$(secret_name "$name")"
    if gcloud secrets describe "$secret" --project "$PROJECT_ID" >/dev/null 2>&1; then
      pairs+=("${name}=${secret}:latest")
    fi
  done
  local IFS=,
  printf '%s' "${pairs[*]}"
}
worker_secrets="$(secret_flags "${WORKER_SECRETS[@]}")"
api_secrets="$(secret_flags "${API_SECRETS[@]}")"
secrets_arg() { if [[ -n "$1" ]]; then printf -- '--set-secrets=%s' "$1"; else printf -- '--clear-secrets'; fi; }
common=(--project "$PROJECT_ID" --region "$REGION" --image "$IMAGE_URI" --cpu 1 --memory 512Mi --timeout 60 --max-instances 1 --concurrency 8)
env_vars="APP_MODE=live,ALLOWED_ORIGINS=${WEB_ORIGIN},BOT_AUTH_AUDIENCE=${WEB_ORIGIN},ARKIV_WRITER_ADDRESS=${ARKIV_WRITER_ADDRESS:-},ARKIV_ENGINE_STREAM=swipr-engine-v1,ARKIV_CONFIRMATIONS=2"
worker_scale=(--min-instances 0 --cpu-throttling)
if [[ -n "${ARKIV_WRITER_ADDRESS:-}" && "$worker_secrets" == *'ARKIV_RELAYER_PK='* ]]; then
  worker_scale=(--min-instances 1 --no-cpu-throttling)
fi
gcloud run deploy swipr-worker "${common[@]}" --service-account "swipr-worker@${PROJECT_ID}.iam.gserviceaccount.com" \
  --port 8788 --no-allow-unauthenticated --ingress all --command npm --args run,worker \
  "${worker_scale[@]}" --set-env-vars "$env_vars" "$(secrets_arg "$worker_secrets")" --quiet
worker_url="$(gcloud run services describe swipr-worker --project "$PROJECT_ID" --region "$REGION" --format='value(status.url)')"
gcloud run services add-iam-policy-binding swipr-worker --project "$PROJECT_ID" --region "$REGION" \
  --member "serviceAccount:swipr-api@${PROJECT_ID}.iam.gserviceaccount.com" --role roles/run.invoker --quiet >/dev/null
gcloud run deploy swipr-api "${common[@]}" --service-account "swipr-api@${PROJECT_ID}.iam.gserviceaccount.com" \
  --port 8787 --allow-unauthenticated --min-instances 0 \
  --set-env-vars "${env_vars},WORKER_URL=${worker_url}" "$(secrets_arg "$api_secrets")" --quiet
api_url="$(gcloud run services describe swipr-api --project "$PROJECT_ID" --region "$REGION" --format='value(status.url)')"
gcloud run services update swipr-api --project "$PROJECT_ID" --region "$REGION" --update-env-vars "PUBLIC_API_URL=${api_url}" --quiet
echo "API: $api_url"
echo "Worker (IAM private): $worker_url"
echo 'Liveness is separate from funded Arkiv/product readiness. Verify /ready before rehearsal.'
