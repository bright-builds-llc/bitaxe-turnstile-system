#!/usr/bin/env bash
# Backup and restore for a self-hosted deployment's PostgreSQL volume (bwg-core Ticket 24).
#
# Usage: scripts/self-host-operations.sh backup --volume NAME --output DIR
#        scripts/self-host-operations.sh restore --volume NAME --keys-dir DIR --input DIR
#   backup   dumps the three databases from the running deployment that uses the volume into
#            DIR (new, owner-only), one `pg_dump` custom-format file each. The dumps hold
#            challenges, Redemption Records and live payout choices, so keep them private.
#   restore  loads such a backup into a new volume, with the password the keys directory's
#            postgres-credential.json holds; launch with that volume afterwards. The volume
#            must not exist, so a restore never overwrites data.
# The keys directory and the Work Lease Authority directory are secrets the operator backs up
# separately; see docs/operations/self-hosted-deployment.md.
set -euo pipefail

POSTGRES_IMAGE="postgres:16-alpine"
DATABASES=(gate_authority relying_service pool_adapter)

refuse() {
  printf 'Refusing: %s\n' "$1" >&2
  exit 2
}

operation=${1:-}
if [[ $# -gt 0 ]]; then
  shift
fi
volume=""
output=""
input=""
keys_dir=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --volume) volume=${2:-}; shift 2 ;;
    --output) output=${2:-}; shift 2 ;;
    --input) input=${2:-}; shift 2 ;;
    --keys-dir) keys_dir=${2:-}; shift 2 ;;
    *) sed -n '4,13p' "$0" >&2; exit 2 ;;
  esac
done
[[ "$volume" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$ ]] || refuse '--volume must be a Docker volume name'

backup() {
  [[ -n "$output" ]] || refuse 'backup needs --output'
  [[ ! -e "$output" ]] || refuse "$output already exists"
  container=$(docker ps --filter "volume=$volume" --format '{{.Names}}' | head -1)
  [[ -n "$container" ]] || refuse "no running deployment uses volume $volume"
  mkdir -m 700 "$output"
  for database in "${DATABASES[@]}"; do
    (
      umask 077
      docker exec "$container" pg_dump -h 127.0.0.1 -U bwg -d "$database" --format=custom >"$output/$database.dump"
    )
  done
  printf 'Backed up %s databases from volume %s into %s\n' "${#DATABASES[@]}" "$volume" "$output"
}

restore() {
  [[ -n "$input" && -n "$keys_dir" ]] || refuse 'restore needs --input and --keys-dir'
  for database in "${DATABASES[@]}"; do
    [[ -s "$input/$database.dump" ]] || refuse "$input has no $database.dump"
  done
  ! docker volume inspect "$volume" >/dev/null 2>&1 || refuse "volume $volume already exists"
  credential="$keys_dir/postgres-credential.json"
  [[ -r "$credential" ]] || refuse "$credential is unreadable"
  password=$(jq -er '.password' "$credential") || refuse "$(basename "$credential") has no password"
  env_file=$(mktemp)
  container="bwg-self-host-restore-$$"
  # Removes the temporary container and its environment file, whatever the outcome.
  restore_cleanup() {
    rm -f "$env_file"
    docker rm -f "$container" >/dev/null 2>&1 || printf 'Remove container %s by hand\n' "$container" >&2
  }
  trap restore_cleanup EXIT
  chmod 600 "$env_file"
  printf 'POSTGRES_USER=bwg\nPOSTGRES_DB=gate_authority\nPOSTGRES_PASSWORD=%s\n' "$password" >"$env_file"
  docker run --detach --name "$container" --env-file "$env_file" \
    --volume "$volume:/var/lib/postgresql/data" "$POSTGRES_IMAGE" >/dev/null
  ready=false
  for _attempt in $(seq 1 300); do
    if docker exec "$container" psql -h 127.0.0.1 -U bwg -d gate_authority -tAc 'SELECT 1' >/dev/null 2>&1; then
      ready=true
      break
    fi
    sleep 0.2
  done
  [[ "$ready" == true ]] || refuse 'the restore database never became ready'
  for database in relying_service pool_adapter; do
    docker exec "$container" psql -h 127.0.0.1 -U bwg -d gate_authority -v ON_ERROR_STOP=1 -qc "CREATE DATABASE $database"
  done
  for database in "${DATABASES[@]}"; do
    docker exec -i "$container" pg_restore -h 127.0.0.1 -U bwg -d "$database" --exit-on-error --no-owner \
      <"$input/$database.dump"
  done
  docker stop "$container" >/dev/null
  printf 'Restored %s databases into volume %s\n' "${#DATABASES[@]}" "$volume"
}

case "$operation" in
  backup) backup ;;
  restore) restore ;;
  *) sed -n '4,13p' "$0" >&2; exit 2 ;;
esac
