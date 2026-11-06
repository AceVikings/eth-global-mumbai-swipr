# shellcheck shell=bash
# shellcheck disable=SC2034 # Arrays are consumed by scripts sourcing this file.
# Sourced by the GCP scripts: which Secret Manager secrets each Cloud Run service may read.
# NAME -> "<SECRET_PREFIX><lower-kebab name>", e.g. ARKIV_RELAYER_PK -> swipr-arkiv-relayer-pk.
# API: read-only Arkiv, Privy verification, read-only provider transports. Never the relayer key.
API_SECRETS=(PRIVY_APP_ID PRIVY_APP_SECRET PRIVY_VERIFICATION_KEY BASE_RPC SEPOLIA_RPC FLASH_KEY_EXEC
  ARKIV_ACCESS_KEY)
# Worker: the only Arkiv writer, plus signer and archive settings.
WORKER_SECRETS=(PRIVY_APP_ID PRIVY_APP_SECRET PRIVY_VERIFICATION_KEY BASE_RPC SEPOLIA_RPC FLASH_KEY_EXEC ARKIV_ACCESS_KEY
  ARKIV_RELAYER_PK ARKIV_MAINTAINER_PK PRIVY_KEY_QUORUM_ID PRIVY_AUTHORIZATION_PRIVATE_KEY
  BEE_URL SWARM_BATCH_ID BEE_GATEWAY_URL BEE_GATEWAY_2_URL)
# Access key is optional. Renewal key can be omitted for a short demo; long-running operation needs it.
OPTIONAL_SECRETS=(ARKIV_ACCESS_KEY ARKIV_MAINTAINER_PK)

SECRET_PREFIX="${SECRET_PREFIX:-swipr-}"
secret_name() { printf '%s%s' "$SECRET_PREFIX" "$(tr '[:upper:]_' '[:lower:]-' <<<"$1")"; }
is_optional_secret() { [[ " ${OPTIONAL_SECRETS[*]} " == *" $1 "* ]]; }
