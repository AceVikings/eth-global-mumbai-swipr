#!/usr/bin/env bash
# Bootstraps what scripts/deploy-cloud-run.sh expects: the Run, Artifact Registry,
# Secret Manager and IAM APIs, the "swipr" Docker repo, and separate swipr-api / swipr-worker
# service accounts. No database: Arkiv is the only store. Creates no secrets and reads no values;
# grants each account access to the swipr-* secrets in infra/secrets.sh that already exist.
# Dry run by default (no gcloud calls). Changes only with --execute AND CONFIRM_PROJECT_ID=PROJECT_ID.
# Never runs `gcloud config set`; every command carries --project.
set -euo pipefail
cd "$(dirname "$0")/.."
source infra/secrets.sh

EXECUTE=false
[[ "${1:-}" == "--execute" ]] && EXECUTE=true

PROJECT_ID="${PROJECT_ID:-}"
REGION="${REGION:-us-central1}"
REPOSITORY="${REPOSITORY:-swipr}"
[[ -n "$PROJECT_ID" ]] || { echo "PROJECT_ID is required (e.g. PROJECT_ID=ethonline-476311 $0)" >&2; exit 2; }
[[ "$REPOSITORY" == swipr* && "$SECRET_PREFIX" == swipr* ]] || { echo "REPOSITORY and SECRET_PREFIX must start with 'swipr'" >&2; exit 2; }
P=(--project "$PROJECT_ID")

if $EXECUTE && [[ "${CONFIRM_PROJECT_ID:-}" != "$PROJECT_ID" ]]; then
  echo "Refusing to provision: set CONFIRM_PROJECT_ID=$PROJECT_ID after the target project is confirmed." >&2
  exit 3
fi
if $EXECUTE; then export CLOUDSDK_CORE_DISABLE_PROMPTS=1; else
  echo "DRY RUN for ${PROJECT_ID}/${REGION} (pass --execute with CONFIRM_PROJECT_ID to provision)"; fi
run() { printf '+'; printf ' %q' "$@"; printf '\n'; if $EXECUTE; then "$@"; fi; }
note() { echo "== $*"; }
# Read-only describe; dry run assumes "missing".
exists() { $EXECUTE && "$@" >/dev/null 2>&1; }
# IAM writes can race a freshly created service account; retry briefly.
retry() {
  local i; for i in 1 2 3 4 5; do "$@" && return 0; $EXECUTE || return 0
    echo "  retrying in $((i * 5))s…" >&2; sleep $((i * 5)); done; return 1
}

note "Enable APIs"
run gcloud services enable "${P[@]}" run.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com iam.googleapis.com

note "Artifact Registry ${REGION}/${REPOSITORY}"
if exists gcloud artifacts repositories describe "$REPOSITORY" "${P[@]}" --location "$REGION"; then echo "  exists"
else run gcloud artifacts repositories create "$REPOSITORY" "${P[@]}" --location "$REGION" \
  --repository-format docker --description "Swipr backend images"; fi

# grant_secrets SA_EMAIL NAME...: accessor on each existing secret only; no project-wide role.
grant_secrets() {
  local sa="$1" name secret; shift
  for name in "$@"; do
    secret="$(secret_name "$name")"
    if ! $EXECUTE || exists gcloud secrets describe "$secret" "${P[@]}"; then
      retry run gcloud secrets add-iam-policy-binding "$secret" "${P[@]}" \
        --member "serviceAccount:${sa}" --role roles/secretmanager.secretAccessor --format none
    else
      echo "  ${secret}: not created yet; grant skipped (create it, then rerun)"
    fi
  done
}

for role in api worker; do
  sa_name="swipr-${role}"; sa="${sa_name}@${PROJECT_ID}.iam.gserviceaccount.com"
  note "Service account ${sa}"
  if exists gcloud iam service-accounts describe "$sa" "${P[@]}"; then echo "  exists"
  else run gcloud iam service-accounts create "$sa_name" "${P[@]}" --display-name "Swipr ${role}" \
    --description "Swipr Cloud Run ${role} runtime identity"; fi
  if [[ $role == api ]]; then grant_secrets "$sa" "${API_SECRETS[@]}"
  else grant_secrets "$sa" "${WORKER_SECRETS[@]}"; fi
done

note "Done. Create needed secrets yourself (value on stdin), then rerun for per-account grants:"
echo "  gcloud secrets create $(secret_name ARKIV_RELAYER_PK) --project ${PROJECT_ID} --replication-policy automatic --data-file=-"
