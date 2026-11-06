#!/usr/bin/env bash
# CI rollout of one immutable commit image. Runtime secrets and service identities are preserved.
set -euo pipefail
: "${PROJECT_ID:?}" "${REGION:?}" "${IMAGE_URI:?}" "${COMMIT_SHA:?}"
[[ "$IMAGE_URI" == "${REGION}-docker.pkg.dev/${PROJECT_ID}/swipr/backend:${COMMIT_SHA}" ]] || exit 2
[[ "$COMMIT_SHA" =~ ^[0-9a-f]{40}$ ]] || exit 2
for role in worker api; do
  service="swipr-${role}"
  expected="${service}@${PROJECT_ID}.iam.gserviceaccount.com"
  actual="$(gcloud run services describe "$service" --project "$PROJECT_ID" --region "$REGION" --format='value(spec.template.spec.serviceAccountName)')"
  [[ "$actual" == "$expected" ]] || { echo "Unexpected runtime identity on ${service}" >&2; exit 3; }
  gcloud run services update "$service" --project "$PROJECT_ID" --region "$REGION" \
    --image "$IMAGE_URI" --update-labels "commit-sha=${COMMIT_SHA}" --quiet
  gcloud run services update-traffic "$service" --project "$PROJECT_ID" --region "$REGION" --to-latest --quiet
  url="$(gcloud run services describe "$service" --project "$PROJECT_ID" --region "$REGION" --format='value(status.url)')"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then printf '%s_url=%s\n' "$role" "$url" >> "$GITHUB_OUTPUT"; fi
  echo "Released ${service} at commit ${COMMIT_SHA}"
done
