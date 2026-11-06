#!/usr/bin/env bash
# Provisions the GCP resources scripts/deploy-cloud-run.sh expects: APIs, the swipr-runtime
# service account, the "swipr" Artifact Registry repo, a Cloud SQL PostgreSQL 16 instance with
# database/user "swipr", and the swipr-database-url secret.
# Dry run by default: prints the plan and makes no gcloud calls at all. Nothing changes unless
# --execute is passed AND CONFIRM_PROJECT_ID equals PROJECT_ID.
# Idempotent: existing resources are verified, never modified destructively. The database
# password is generated only when the user is new, travels via stdin and a mode-600 flags file,
# and is never printed or passed as a command-line argument.
# Never runs `gcloud config set`; every command carries --project explicitly.
set -euo pipefail

EXECUTE=false
[[ "${1:-}" == "--execute" ]] && EXECUTE=true

PROJECT_ID="${PROJECT_ID:-}"
REGION="${REGION:-us-central1}"
REPOSITORY="${REPOSITORY:-swipr}"
SA_NAME="${SA_NAME:-swipr-runtime}"
INSTANCE="${INSTANCE:-swipr-db}"
DB_NAME="${DB_NAME:-swipr}"
DB_USER="${DB_USER:-swipr}"
DB_SECRET="${DB_SECRET:-swipr-database-url}"
DB_VERSION=POSTGRES_16

[[ -n "$PROJECT_ID" ]] || { echo "PROJECT_ID is required (e.g. PROJECT_ID=ethonline-476311 $0)" >&2; exit 2; }
for name in REPOSITORY SA_NAME INSTANCE DB_SECRET; do
  [[ "${!name}" == swipr* ]] || { echo "$name must start with 'swipr' (got ${!name})" >&2; exit 2; }
done

SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
CONNECTION="${PROJECT_ID}:${REGION}:${INSTANCE}"
P=(--project "$PROJECT_ID")

if $EXECUTE && [[ "${CONFIRM_PROJECT_ID:-}" != "$PROJECT_ID" ]]; then
  echo "Refusing to provision: set CONFIRM_PROJECT_ID=$PROJECT_ID after the target project is confirmed." >&2
  exit 3
fi
if $EXECUTE; then
  export CLOUDSDK_CORE_DISABLE_PROMPTS=1 # this process only; global gcloud config is untouched
  command -v openssl >/dev/null || { echo "openssl is required to generate the password" >&2; exit 2; }
else
  echo "DRY RUN for ${PROJECT_ID}/${REGION} (pass --execute with CONFIRM_PROJECT_ID to provision)"
fi

run() {
  printf '+'; printf ' %q' "$@"; printf '\n'
  if $EXECUTE; then "$@"; fi
}
note() { echo "== $*"; }
# exists CMD...: true when a read-only describe succeeds. Dry run assumes "missing".
exists() { $EXECUTE && "$@" >/dev/null 2>&1; }
# IAM writes can race a freshly created service account; retry briefly.
retry() {
  local i
  for i in 1 2 3 4 5; do
    "$@" && return 0
    $EXECUTE || return 0
    echo "  retrying in $((i * 5))s…" >&2; sleep $((i * 5))
  done
  return 1
}

note "Enable APIs"
run gcloud services enable "${P[@]}" sqladmin.googleapis.com secretmanager.googleapis.com \
  artifactregistry.googleapis.com run.googleapis.com cloudbuild.googleapis.com iam.googleapis.com

note "Runtime service account ${SA_EMAIL}"
if exists gcloud iam service-accounts describe "$SA_EMAIL" "${P[@]}"; then
  echo "  exists"
else
  run gcloud iam service-accounts create "$SA_NAME" "${P[@]}" \
    --display-name "Swipr Cloud Run runtime" --description "Swipr API and worker runtime identity"
fi
# Project-level Cloud SQL client only; secret access is granted per secret below.
retry run gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member "serviceAccount:${SA_EMAIL}" --role roles/cloudsql.client --condition None --quiet \
  --format none

note "Artifact Registry ${REGION}/${REPOSITORY}"
if exists gcloud artifacts repositories describe "$REPOSITORY" "${P[@]}" --location "$REGION"; then
  echo "  exists"
else
  run gcloud artifacts repositories create "$REPOSITORY" "${P[@]}" --location "$REGION" \
    --repository-format docker --description "Swipr backend images"
fi

note "Cloud SQL instance ${CONNECTION}"
if exists gcloud sql instances describe "$INSTANCE" "${P[@]}"; then
  actual="$(gcloud sql instances describe "$INSTANCE" "${P[@]}" --format 'value(region,databaseVersion)')"
  read -r actual_region actual_version <<<"$actual"
  if [[ "$actual_region" != "$REGION" || "$actual_version" != "$DB_VERSION" ]]; then
    echo "Existing instance ${INSTANCE} is ${actual_region}/${actual_version}, expected ${REGION}/${DB_VERSION}." >&2
    echo "Refusing to modify it; choose another INSTANCE=swipr-… name or fix it manually." >&2
    exit 4
  fi
  networks="$(gcloud sql instances describe "$INSTANCE" "${P[@]}" \
    --format 'value(settings.ipConfiguration.authorizedNetworks[].value)')"
  [[ -z "$networks" ]] || echo "  WARNING: authorized networks present (${networks}); left unchanged" >&2
  echo "  exists (${actual_region}, ${actual_version}); settings left unchanged"
else
  # Shared-core, smallest tier. Public IP has no authorized networks and connector
  # enforcement, so only the Cloud SQL Auth Proxy / Cloud Run socket can connect, over TLS.
  # beta: --storage-auto-increase-limit (the 20 GB cap) is not in the GA surface.
  run gcloud beta sql instances create "$INSTANCE" "${P[@]}" --region "$REGION" \
    --database-version "$DB_VERSION" --edition ENTERPRISE --tier db-f1-micro \
    --availability-type zonal --storage-type SSD --storage-size 10GB \
    --storage-auto-increase --storage-auto-increase-limit 20 \
    --assign-ip --connector-enforcement REQUIRED --ssl-mode ENCRYPTED_ONLY \
    --backup-start-time 03:00 --retained-backups-count 7 \
    --enable-point-in-time-recovery --retained-transaction-log-days 7 \
    --deletion-protection --labels app=swipr
fi

note "Database ${DB_NAME}"
if exists gcloud sql databases describe "$DB_NAME" "${P[@]}" --instance "$INSTANCE"; then
  echo "  exists"
else
  run gcloud sql databases create "$DB_NAME" "${P[@]}" --instance "$INSTANCE"
fi

note "Database user ${DB_USER} and secret ${DB_SECRET}"
user_exists=false; secret_exists=false
if $EXECUTE; then
  # Must fail hard: a failed lookup misread as "no user" would rotate the stored URL.
  users="$(gcloud sql users list "${P[@]}" --instance "$INSTANCE" --format 'value(name)')"
  grep -qxF "$DB_USER" <<<"$users" && user_exists=true
  exists gcloud secrets describe "$DB_SECRET" "${P[@]}" && secret_exists=true
fi

if $user_exists && $secret_exists; then
  echo "  user and secret exist; password left unchanged"
elif $user_exists; then
  echo "User ${DB_USER} exists but secret ${DB_SECRET} does not." >&2
  echo "Refusing to reset the password silently. Recover explicitly, e.g. after confirming no" >&2
  echo "running service depends on the current password:" >&2
  echo "  gcloud sql users delete ${DB_USER} --instance ${INSTANCE} --project ${PROJECT_ID}" >&2
  echo "then rerun this script; or store the known URL in ${DB_SECRET} yourself." >&2
  exit 5
else
  $secret_exists && echo "  secret exists without the user; a new version will supersede it"
  if ! $secret_exists; then
    run gcloud secrets create "$DB_SECRET" "${P[@]}" --replication-policy automatic --labels app=swipr
  fi
  if $EXECUTE; then
    # Hex is URL-safe, so the password needs no percent-encoding in the connection URL.
    password="$(openssl rand -hex 32)"
    [[ "$password" =~ ^[0-9a-f]{64}$ ]] || { echo "password generation failed" >&2; exit 6; }
    # Store the secret before creating the user: a crash in between leaves a retryable state
    # (user missing), never a user whose password exists nowhere.
    printf 'postgresql://%s:%s@localhost/%s?host=/cloudsql/%s' \
      "$DB_USER" "$password" "$DB_NAME" "$CONNECTION" |
      gcloud secrets versions add "$DB_SECRET" "${P[@]}" --data-file=- --format none
    echo "  stored new ${DB_SECRET} version (value not shown)"
    tmpdir="$(umask 077; mktemp -d)"
    trap 'rm -rf "$tmpdir"' EXIT
    flags="${tmpdir}/user-flags.yaml"
    (umask 077; printf -- '--password: "%s"\n' "$password" >"$flags")
    unset password
    gcloud sql users create "$DB_USER" "${P[@]}" --instance "$INSTANCE" --flags-file "$flags"
    rm -f "$flags"
  else
    echo "+ printf <generated URL> | gcloud secrets versions add ${DB_SECRET} --project ${PROJECT_ID} --data-file=-"
    echo "+ gcloud sql users create ${DB_USER} --project ${PROJECT_ID} --instance ${INSTANCE} --flags-file <mode-600 tmp>"
    echo "  (on --execute: if ${DB_USER} already exists without ${DB_SECRET}, the script stops instead)"
  fi
fi

note "Secret access for ${SA_EMAIL} on ${DB_SECRET} only"
retry run gcloud secrets add-iam-policy-binding "$DB_SECRET" "${P[@]}" \
  --member "serviceAccount:${SA_EMAIL}" --role roles/secretmanager.secretAccessor --format none

note "Done. For scripts/deploy-cloud-run.sh:"
echo "  PROJECT_ID=${PROJECT_ID} REGION=${REGION} REPOSITORY=${REPOSITORY}"
echo "  SERVICE_ACCOUNT=${SA_EMAIL}"
echo "  CLOUD_SQL_CONNECTION=${CONNECTION}"
echo "Other swipr-* provider secrets need their own per-secret accessor binding for ${SA_NAME}."
