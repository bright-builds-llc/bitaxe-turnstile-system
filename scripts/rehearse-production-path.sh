#!/usr/bin/env bash
# Rehearses the production path on regtest with test keys only (Ticket 06).
#
# Starts pinned Bitcoin Core and Hydra, PostgreSQL, the production `gate-authority`
# (with the in-process Stratum V1 proxy, delivery and sweep of ADR-0109) and
# `reference-service` binaries behind one HTTPS origin, and drives the reference
# page in Chromium with a fake serial Worker and a CPU miner.
# macOS arm64 only, like the Hydra runner. Not part of `bun run verify`.
#
# Usage: scripts/rehearse-production-path.sh [--hold]
#   --hold  start the stack, print its configuration and wait instead of the browser run.
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
integration_root=$(mktemp -d)
playwright_cli="$repo_root/node_modules/.bin/playwright-cli"
session_name="bwg-rehearsal-$$"
hold=false
if [[ "${1:-}" == "--hold" ]]; then
  hold=true
elif [[ $# -gt 0 ]]; then
  printf 'Usage: %s [--hold]\n' "$0" >&2
  exit 2
fi

# shellcheck source=scripts/hydra-regtest-stack.sh
source "$repo_root/scripts/hydra-regtest-stack.sh"

harness_pid=""
authority_pid=""
reference_pid=""
server_pid=""
kept_logs="$repo_root/target/rehearsal-logs"

# Called from cleanup under `set +e`; a process that already exited needs no stop.
stop_process() {
  if [[ -n "$1" ]] && kill -0 "$1" 2>/dev/null; then
    kill "$1"
    wait "$1" 2>/dev/null
  fi
}

cleanup() {
  command_exit=$?
  trap - EXIT INT TERM
  set +e
  "$playwright_cli" -s="$session_name" close >/dev/null 2>&1
  stop_process "$server_pid"
  stop_process "$reference_pid"
  stop_process "$authority_pid"
  stop_process "$harness_pid"
  if ! stop_hydra; then
    command_exit=1
  fi
  if ! stop_bitcoind; then
    command_exit=1
  fi
  if ((command_exit != 0)); then
    rm -rf "$kept_logs"
    mkdir -p "$kept_logs"
    cp "$integration_root"/*.log "$kept_logs"/
    printf 'Logs kept in %s\n' "$kept_logs" >&2
    for log_path in "$integration_root"/gate-authority.log "$integration_root"/browser.log; do
      if [[ -s "$log_path" ]]; then
        printf '%s (last 80 lines):\n' "$(basename "$log_path")" >&2
        tail -n 80 "$log_path" >&2
      fi
    done
  fi
  rm -rf "$integration_root"
  exit "$command_exit"
}
trap cleanup EXIT INT TERM

wait_for_first_line() {
  path=$1
  pattern=$2
  for _attempt in $(seq 1 1800); do
    if [[ -s "$path" ]] && head -n 1 "$path" | grep -Eq "$pattern"; then
      head -n 1 "$path"
      return 0
    fi
    sleep 0.1
  done
  printf 'No ready line in %s\n' "$path" >&2
  return 1
}

for required in bun openssl; do
  require_command "$required"
done
prepare_pinned_stack
start_regtest_stack
start_hydra

cd "$repo_root"
bun run build:browser >"$integration_root/build.log" 2>&1
cargo build --quiet --all-features --bin gate-authority --bin reference-service \
  --example production-path-rehearsal
front_port=$(free_port)
gate_port=$(free_port)
reference_port=$(free_port)
proxy_port=$(free_port)
origin="https://gate.rehearsal.test:$front_port"
BWG_REHEARSAL_ORIGIN="$origin" \
  BWG_REHEARSAL_GATE_ADDRESS="127.0.0.1:$gate_port" \
  BWG_REHEARSAL_REFERENCE_ADDRESS="127.0.0.1:$reference_port" \
  BWG_REHEARSAL_PROXY_ADDRESS="127.0.0.1:$proxy_port" \
  BWG_HYDRA_STRATUM_ADDR="127.0.0.1:$stratum_port" \
  target/debug/examples/production-path-rehearsal \
  >"$integration_root/harness.json" 2>"$integration_root/harness.log" &
harness_pid=$!
composition=$(wait_for_first_line "$integration_root/harness.json" '^\{')

# Runs one production binary with the harness's test-key environment for it.
start_binary() {
  binary=$1
  key=$2
  binary_env=()
  while IFS= read -r -d '' assignment; do
    binary_env+=("$assignment")
  done < <(jq -j --arg key "$key" '.env[$key] | to_entries[] | "\(.key)=\(.value)\u0000"' <<<"$composition")
  env "${binary_env[@]}" RUST_LOG=info "target/debug/$binary" >"$integration_root/$binary.log" 2>&1 &
}
start_binary gate-authority gateAuthority
authority_pid=$!
wait_for_port "$gate_port"
wait_for_port "$proxy_port"
start_binary reference-service referenceService
reference_pid=$!
wait_for_port "$reference_port"

rehearsal_config=$(jq -c --arg payout "$payout_address" \
  '{origin, control, authorityTrust, payoutAddress: $payout}' <<<"$composition")
# A throwaway certificate for the loopback front; Chromium ignores its trust.
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=gate.rehearsal.test" \
  -keyout "$integration_root/front-key.pem" -out "$integration_root/front-cert.pem" \
  >/dev/null 2>&1
BWG_REHEARSAL_GATE="http://127.0.0.1:$gate_port" \
  BWG_REHEARSAL_REFERENCE="http://127.0.0.1:$reference_port" \
  BWG_REHEARSAL_FRONT_PORT="$front_port" \
  BWG_REHEARSAL_CONFIG_JSON="$rehearsal_config" \
  BWG_REHEARSAL_TLS_CERT="$integration_root/front-cert.pem" \
  BWG_REHEARSAL_TLS_KEY="$integration_root/front-key.pem" \
  bun scripts/serve-rehearsal-origin.ts >"$integration_root/server.log" 2>&1 &
server_pid=$!
wait_for_first_line "$integration_root/server.log" '^[0-9]+$' >/dev/null

if [[ "$hold" == true ]]; then
  printf 'origin=%s (resolve gate.rehearsal.test to 127.0.0.1)\n%s\n' "$origin" "$rehearsal_config"
  printf 'Holding the rehearsal stack; press Ctrl-C to stop.\n'
  wait "$authority_pid"
  exit 1
fi

"$playwright_cli" -s="$session_name" open \
  --config "$repo_root/.playwright/production-path-rehearsal.config.json" \
  "$origin/reference/production-path-rehearsal.html" >"$integration_root/browser.log"
"$playwright_cli" -s="$session_name" run-code \
  --filename "$repo_root/scripts/run-production-path-rehearsal.mjs" \
  >>"$integration_root/browser.log"
if ! grep -q 'rehearsal: passed' "$integration_root/browser.log"; then
  printf 'Production-path rehearsal did not pass\n' >&2
  exit 1
fi
# `run-code` prints the runner's result as a JSON string; print the evidence object.
sed -n 's/.*rehearsal: evidence \(.*\)"$/\1/p' "$integration_root/browser.log" | sed 's/\\"/"/g'
printf 'Production-path rehearsal passed\n'
