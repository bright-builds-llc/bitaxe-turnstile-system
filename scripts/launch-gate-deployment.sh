#!/usr/bin/env bash
# Launches a Gate deployment for Ticket 07, run by the owner in their own shell:
# PostgreSQL, `gate-authority` with the in-process Pool Adapter (ADR-0109),
# `reference-service` and the same-origin front, published on this Mac's tailnet
# name by `tailscale serve`. Private values are read from files at run time and
# reach the binaries only through their environment, never a command line, the
# repository or a log. Hydra runs separately (`scripts/hydra-mainnet-stack.sh`).
#
# Usage: scripts/launch-gate-deployment.sh --keys-dir DIR --lease-authority-dir DIR
#          --owner-trust FILE --image-dir DIR --run-dir DIR
#          [--upstream HOST:PORT] [--proxy-port PORT] [--sequence-margin N]
#          [--proxy-address ADDRESS] [--loopback-origin URL] [--expected-hashes N]
#   --keys-dir             output of scripts/gate-deployment-keys.ts
#   --lease-authority-dir  the Work Lease Authority's lease-private.json and lease-sequence.json
#   --owner-trust          the public Worker deployment trust the board's image embeds
#   --image-dir            the C image's COMMIT and SHA256SUMS
#   --run-dir              owner-only directory outside the repository for logs
#   --upstream             Hydra's loopback Stratum (default 127.0.0.1:3333)
#   --proxy-port           the Pool Adapter proxy's port on the LAN address (default 3334)
#   --sequence-margin      added to the stored lease sequence before seeding (default 1000)
#   --proxy-address        the LAN address to bind instead of the default interface's
#   --loopback-origin      regtest proofs only: skip Tailscale; the caller terminates
#                          TLS for this origin (needs --proxy-address)
#   --expected-hashes      each challenge's Work Requirement, within the Standard
#                          policy's override bounds (default: the policy's own)
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd -P)
keys_dir=""
lease_dir=""
owner_trust=""
image_dir=""
run_dir=""
upstream="127.0.0.1:3333"
proxy_port=3334
sequence_margin=1000
loopback_origin=""
proxy_address=""
expected_hashes=""
ACTION_POLICY="account-creation.standard.v1"
POSTGRES_IMAGE="postgres:16-alpine"

usage() {
  sed -n '9,25p' "$0" >&2
  exit 2
}

refuse() {
  printf 'Refusing to launch: %s\n' "$1" >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keys-dir) keys_dir=${2:-}; shift 2 ;;
    --lease-authority-dir) lease_dir=${2:-}; shift 2 ;;
    --owner-trust) owner_trust=${2:-}; shift 2 ;;
    --image-dir) image_dir=${2:-}; shift 2 ;;
    --run-dir) run_dir=${2:-}; shift 2 ;;
    --upstream) upstream=${2:-}; shift 2 ;;
    --proxy-port) proxy_port=${2:-}; shift 2 ;;
    --sequence-margin) sequence_margin=${2:-}; shift 2 ;;
    --loopback-origin) loopback_origin=${2:-}; shift 2 ;;
    --proxy-address) proxy_address=${2:-}; shift 2 ;;
    --expected-hashes) expected_hashes=${2:-}; shift 2 ;;
    *) usage ;;
  esac
done
if [[ -z "$keys_dir" || -z "$lease_dir" || -z "$owner_trust" || -z "$image_dir" || -z "$run_dir" ]]; then
  usage
fi
if [[ -n "$loopback_origin" && -z "$proxy_address" ]]; then
  refuse '--loopback-origin needs --proxy-address'
fi
[[ "$proxy_port" =~ ^[0-9]{1,5}$ ]] || refuse '--proxy-port must be a port number'
[[ "$sequence_margin" =~ ^[0-9]{1,9}$ ]] || refuse '--sequence-margin must be a whole number'
[[ "$upstream" =~ ^127\.0\.0\.1:[0-9]{1,5}$ ]] || refuse '--upstream must be 127.0.0.1:PORT'
[[ -z "$expected_hashes" || "$expected_hashes" =~ ^[0-9]{1,20}$ ]] || refuse '--expected-hashes must be a whole number'

outside_repo() {
  resolved=$(cd "$1" && pwd -P)
  [[ "$resolved/" != "$repo_root/"* ]] || refuse "$2 must be outside the repository"
  printf '%s\n' "$resolved"
}

require_owner_only() {
  [[ -f "$1" && -r "$1" ]] || refuse "$(basename "$1") is missing or unreadable"
  (((8#$(stat -f '%Lp' "$1") & 8#077) == 0)) || refuse "$(basename "$1") must be readable only by its owner"
}

for required in bun cargo curl docker jq nc python3; do
  command -v "$required" >/dev/null || refuse "$required is unavailable"
done
for directory in "$keys_dir" "$lease_dir" "$image_dir"; do
  [[ -d "$directory" ]] || refuse "$directory is not a directory"
done
keys_dir=$(outside_repo "$keys_dir" --keys-dir)
lease_dir=$(outside_repo "$lease_dir" --lease-authority-dir)
mkdir -p "$run_dir"
chmod 700 "$run_dir"
run_dir=$(outside_repo "$run_dir" --run-dir)

# Private values: read once into this shell, validated, never printed.
for name in gate-pass-signing.json gate-pass-public-keys.json service-credential.json stratum-credential-key.json; do
  require_owner_only "$keys_dir/$name"
done
signing_kid=$(jq -er '.kid' "$keys_dir/gate-pass-signing.json") || refuse 'gate-pass-signing.json has no kid'
signing_seed=$(jq -er '.seed' "$keys_dir/gate-pass-signing.json") || refuse 'gate-pass-signing.json has no seed'
public_keys=$(jq -ec --arg kid "$signing_kid" 'select(type == "array" and any(.[]; .kid == $kid))' \
  "$keys_dir/gate-pass-public-keys.json") || refuse 'gate-pass-public-keys.json does not hold the signing kid'
service_client_id=$(jq -er '.clientId' "$keys_dir/service-credential.json") || refuse 'service-credential.json has no clientId'
service_credential=$(jq -er '.credential' "$keys_dir/service-credential.json") || refuse 'service-credential.json has no credential'
stratum_key=$(jq -er '.key' "$keys_dir/stratum-credential-key.json") || refuse 'stratum-credential-key.json has no key'

# The Work Lease Authority key must be the one the board's trust names.
lease_private="$lease_dir/lease-private.json"
lease_sequence_file="$lease_dir/lease-sequence.json"
require_owner_only "$lease_private"
require_owner_only "$lease_sequence_file"
lease_kid=$(jq -er 'select(.role == "work_lease_authority") | .activeKid' "$lease_private") ||
  refuse 'lease-private.json is not a Work Lease Authority with an active kid'
[[ "$lease_kid" =~ ^[A-Za-z0-9_-]{1,32}$ ]] || refuse 'the lease kid is malformed'
lease_x=$(jq -er --arg kid "$lease_kid" '.keys[] | select(.kid == $kid) | .x' "$lease_private") ||
  refuse 'lease-private.json has no public key for its active kid'
lease_seed=$(jq -er --arg kid "$lease_kid" '.keys[] | select(.kid == $kid) | .d' "$lease_private") ||
  refuse 'lease-private.json has no seed for its active kid'
lease_issuer=$(jq -er --arg kid "$lease_kid" --arg x "$lease_x" \
  '.workLeaseAuthority | select(any(.keys[]; .kid == $kid and .x == $x)) | .issuer' "$owner_trust") ||
  refuse "the active lease key $lease_kid is not in the owner trust"
stored_sequence=$(jq -er --arg kid "$lease_kid" '.sequences[$kid]' "$lease_sequence_file") ||
  refuse "lease-sequence.json has no sequence for $lease_kid"
[[ "$stored_sequence" =~ ^(0|[1-9][0-9]{0,17})$ ]] || refuse 'the stored lease sequence is not a whole number below 10^18'
seeded_sequence=$((stored_sequence + sequence_margin))

# Public origin and the address the board reaches the proxy on.
if [[ -n "$loopback_origin" ]]; then
  origin=$loopback_origin
else
  command -v tailscale >/dev/null || refuse 'tailscale is unavailable'
  tailscale_status=$(tailscale status --json) || refuse 'tailscale is not running'
  jq -e '.CertDomains | length > 0' <<<"$tailscale_status" >/dev/null ||
    refuse 'turn on HTTPS certificates for the tailnet first'
  origin="https://$(jq -er '.Self.DNSName | rtrimstr(".")' <<<"$tailscale_status")"
fi
if [[ -z "$proxy_address" ]]; then
  default_interface=$(route -n get default | awk '/interface:/ { print $2 }')
  proxy_address=$(ipconfig getifaddr "$default_interface") ||
    refuse 'no LAN address on the default interface; pass --proxy-address'
fi
[[ "$proxy_address" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || refuse 'the proxy address must be an IPv4 address'
[[ "$origin" =~ ^https://[A-Za-z0-9.-]+$ ]] || refuse 'the origin must be https://HOST'
origin_host=${origin#https://}
nc -z "${upstream%:*}" "${upstream##*:}" || refuse "no Stratum upstream on $upstream; start Hydra first"

gate_commit=$(git -C "$repo_root" rev-parse HEAD)
worktree_state=clean
if [[ -n "$(git -C "$repo_root" status --porcelain)" ]]; then
  worktree_state=dirty
fi

authority_pid=""
reference_pid=""
front_pid=""
serve_configured=false
postgres_container=""
sequence_seeded=false

stop_process() {
  if [[ -n "$1" ]] && kill -0 "$1" 2>/dev/null; then
    kill "$1"
    wait "$1" 2>/dev/null
  fi
}

postgres_query() {
  docker exec "$postgres_container" psql -h 127.0.0.1 -U bwg -d gate_authority -v ON_ERROR_STOP=1 -tAc "$1"
}

# Raises lease-sequence.json to the database's high-water mark, under the
# development authority's lock, so a later fresh database still starts above
# every sequence the board has seen.
record_lease_sequence() {
  final_sequence=$(postgres_query "SELECT last_sequence FROM gate_authority.work_lease_authorization_sequences WHERE key_id = '$lease_kid'")
  [[ "$final_sequence" =~ ^[0-9]+$ ]] || return 1
  current=$(jq -er --arg kid "$lease_kid" '.sequences[$kid]' "$lease_sequence_file") || return 1
  [[ "$current" =~ ^[0-9]+$ ]] || return 1
  lock_path="$lease_dir/authority.lock"
  lock_claim="$lease_dir/.launcher-lock-$$"
  printf '%s\n' "$$" >"$lock_claim"
  if ! ln "$lock_claim" "$lock_path" 2>/dev/null; then
    rm -f "$lock_claim"
    printf 'The lease authority is locked; raise %s for %s to %s by hand\n' \
      "$(basename "$lease_sequence_file")" "$lease_kid" "$final_sequence" >&2
    return 1
  fi
  record_status=0
  if ((final_sequence > current)); then
    (
      umask 077
      jq --arg kid "$lease_kid" --arg sequence "$final_sequence" '.sequences[$kid] = $sequence' \
        "$lease_sequence_file" >"$lease_sequence_file.launcher-$$"
    ) && mv "$lease_sequence_file.launcher-$$" "$lease_sequence_file" || record_status=1
  fi
  rm -f "$lock_path" "$lock_claim"
  if ((record_status == 0)); then
    printf 'Lease sequence for %s recorded as %s\n' "$lease_kid" "$final_sequence"
  fi
  return "$record_status"
}

cleanup() {
  command_exit=$?
  trap - EXIT INT TERM
  set +e
  if [[ "$serve_configured" == true ]]; then
    tailscale serve --https=443 off >>"$run_dir/tailscale-serve.log" 2>&1 || command_exit=1
  fi
  stop_process "$front_pid"
  stop_process "$reference_pid"
  stop_process "$authority_pid"
  if [[ "$sequence_seeded" == true ]] && ! record_lease_sequence; then
    printf 'Failed to record the lease sequence high-water mark\n' >&2
    command_exit=1
  fi
  if [[ -n "$postgres_container" ]]; then
    docker rm -f "$postgres_container" >/dev/null || command_exit=1
  fi
  rm -f "$run_dir/postgres.env"
  exit "$command_exit"
}
trap cleanup EXIT
# Ctrl-C is the normal stop.
trap 'exit 0' INT TERM

free_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'
}

wait_for_port() {
  for _attempt in $(seq 1 600); do
    if nc -z "$1" "$2" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done
  printf 'Nothing listening on port %s\n' "$2" >&2
  return 1
}

# Keeps the LAN address and the tailnet name out of the run's logs.
redact() {
  sed -l -e "s/${proxy_address//./\\.}/LAN_ADDRESS/g" -e "s/${origin_host//./\\.}/ORIGIN_HOST/g"
}

cd "$repo_root"
bun run build:browser >"$run_dir/build.log" 2>&1
cargo build --quiet --all-features --bin gate-authority --bin reference-service
bun scripts/gate-deployment-page-config.ts --origin "$origin" \
  --public-keys "$keys_dir/gate-pass-public-keys.json" --owner-trust "$owner_trust" \
  --image-dir "$image_dir" --gate-commit "$gate_commit" >"$run_dir/page-config.json"

postgres_password=$(python3 -c 'import secrets; print(secrets.token_hex(24))')
(
  umask 077
  printf 'POSTGRES_USER=bwg\nPOSTGRES_DB=gate_authority\nPOSTGRES_PASSWORD=%s\n' "$postgres_password" \
    >"$run_dir/postgres.env"
)
container_name="bwg-gate-deployment-$$"
docker run --detach --name "$container_name" --env-file "$run_dir/postgres.env" \
  --publish 127.0.0.1::5432 "$POSTGRES_IMAGE" >/dev/null
postgres_container=$container_name
rm -f "$run_dir/postgres.env"
# The image's init server listens only on its socket, so a TCP query means it is ready.
for _attempt in $(seq 1 300); do
  if postgres_query 'SELECT 1' >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done
postgres_query 'CREATE DATABASE relying_service' >/dev/null
postgres_query 'CREATE DATABASE pool_adapter' >/dev/null
postgres_port=$(docker port "$postgres_container" 5432/tcp | head -1)
postgres_port=${postgres_port##*:}
database_base="postgres://bwg:$postgres_password@127.0.0.1:$postgres_port"

gate_port=$(free_port)
reference_port=$(free_port)
front_port=$(free_port)
(
  export BWG_ENVIRONMENT=production BWG_LISTEN_ADDRESS="127.0.0.1:$gate_port"
  export BWG_SERVICE_CLIENT_ID="$service_client_id" BWG_SERVICE_CREDENTIAL="$service_credential"
  export BWG_RELYING_SERVICE_AUDIENCE="$origin" BWG_ALLOWED_ORIGINS="$origin"
  export BWG_ALLOWED_ACTION_POLICIES="$ACTION_POLICY"
  export BWG_AUTHORITY_ISSUER="$origin" BWG_AUTHORITY_PUBLIC_BASE_URL="$origin"
  export BWG_AUTHORITY_JWKS_JSON="$public_keys" BWG_AUTHORITY_SIGNING_KID="$signing_kid"
  export BWG_AUTHORITY_SIGNING_SEED="$signing_seed"
  export BWG_OPERATOR_POLICY_URL="$origin/policies/operator" BWG_PRIVACY_URL="$origin/privacy"
  export BWG_TERMS_URL="$origin/terms"
  export BWG_AUTHORITY_DATABASE_URL="$database_base/gate_authority"
  export BWG_WORK_LEASE_AUTHORITY_KID="$lease_kid" BWG_WORK_LEASE_AUTHORITY_ISSUER="$lease_issuer"
  export BWG_WORK_LEASE_AUTHORITY_SEED="$lease_seed" BWG_STRATUM_CREDENTIAL_KEY="$stratum_key"
  export BWG_POOL_ADAPTER_DATABASE_URL="$database_base/pool_adapter"
  export BWG_WORKER_STRATUM_ENDPOINT="stratum+tcp://$proxy_address:$proxy_port/"
  export BWG_STRATUM_PROXY_LISTEN_ADDRESS="$proxy_address:$proxy_port"
  export BWG_POOL_UPSTREAM_STRATUM_ADDRESS="$upstream" BWG_POOL_UPSTREAM_PASSWORD=x RUST_LOG=info
  exec target/debug/gate-authority
) > >(redact >"$run_dir/gate-authority.log") 2>&1 &
authority_pid=$!
wait_for_port 127.0.0.1 "$gate_port"
wait_for_port "$proxy_address" "$proxy_port"

# The Authority has run its migrations; nothing can reach it until the front starts.
postgres_query "INSERT INTO gate_authority.work_lease_authorization_sequences (key_id, last_sequence)
  VALUES ('$lease_kid', $seeded_sequence)
  ON CONFLICT (key_id) DO UPDATE SET last_sequence = GREATEST(
    gate_authority.work_lease_authorization_sequences.last_sequence, EXCLUDED.last_sequence)" >/dev/null
[[ "$(postgres_query "SELECT last_sequence FROM gate_authority.work_lease_authorization_sequences WHERE key_id = '$lease_kid'")" == "$seeded_sequence" ]] ||
  refuse 'the lease sequence did not seed'
sequence_seeded=true

(
  export BWG_LISTEN_ADDRESS="127.0.0.1:$reference_port" BWG_AUTHORITY_BASE_URL="http://127.0.0.1:$gate_port"
  export BWG_SERVICE_CLIENT_ID="$service_client_id" BWG_SERVICE_CREDENTIAL="$service_credential"
  export BWG_TRUSTED_AUTHORITY_ISSUER="$origin" BWG_TRUSTED_AUTHORITY_JWKS_JSON="$public_keys"
  export BWG_RELYING_SERVICE_AUDIENCE="$origin" BWG_REDEMPTION_URL="$origin/account-creation/redeem"
  export BWG_RELYING_SERVICE_DATABASE_URL="$database_base/relying_service" RUST_LOG=info
  if [[ -n "$expected_hashes" ]]; then export BWG_EXPECTED_HASHES_OVERRIDE="$expected_hashes"; fi
  exec target/debug/reference-service
) > >(redact >"$run_dir/reference-service.log") 2>&1 &
reference_pid=$!
wait_for_port 127.0.0.1 "$reference_port"

BWG_FRONT_PORT="$front_port" BWG_FRONT_GATE="http://127.0.0.1:$gate_port" \
  BWG_FRONT_REFERENCE="http://127.0.0.1:$reference_port" \
  BWG_FRONT_PAGE_CONFIG_FILE="$run_dir/page-config.json" \
  bun scripts/serve-gate-origin.ts > >(redact >"$run_dir/front.log") 2>&1 &
front_pid=$!
wait_for_port 127.0.0.1 "$front_port"

if [[ -z "$loopback_origin" ]]; then
  # The serve is set in tailscaled and removed on exit: the `tailscale` command
  # may be a wrapper script, and killing it would leave the real CLI serving.
  serve_configured=true
  tailscale serve --bg --https=443 "http://127.0.0.1:$front_port" > >(redact >"$run_dir/tailscale-serve.log") 2>&1 ||
    refuse "tailscale serve failed; see $run_dir/tailscale-serve.log"
  for _attempt in $(seq 1 60); do
    if curl --fail --silent --output /dev/null "$origin/reference/account-creation.html"; then
      break
    fi
    sleep 1
  done
  curl --fail --silent --show-error --output /dev/null "$origin/reference/account-creation.html" ||
    refuse "the tailnet origin does not serve the page; see $run_dir/tailscale-serve.log"
fi

printf 'Gate commit %s (%s worktree)\n' "$gate_commit" "$worktree_state"
printf 'Gate Pass kid %s; Work Lease kid %s, sequence seeded at %s (stored %s + margin %s)\n' \
  "$signing_kid" "$lease_kid" "$seeded_sequence" "$stored_sequence" "$sequence_margin"
printf 'Open %s/reference/account-creation.html; logs are in %s\n' "$origin" "$run_dir"
printf 'gate_deployment=ready front_port=%s postgres_container=%s\n' "$front_port" "$postgres_container"
printf 'Holding the Gate deployment; press Ctrl-C to stop.\n'
wait -n "$authority_pid" "$reference_pid" "$front_pid"
printf 'A Gate process exited; stopping the deployment\n' >&2
exit 1
