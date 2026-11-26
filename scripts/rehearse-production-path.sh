#!/usr/bin/env bash
# Rehearses the production path on regtest with test keys only (Ticket 06).
#
# Starts pinned Bitcoin Core and Hydra, PostgreSQL, the production `gate-authority`,
# `pool-adapter` (the Stratum V1 proxy, delivery and sweep, over loopback gRPC to the
# Authority, ADR-0113) and `reference-service` binaries behind one HTTPS origin, and drives the reference
# page in Chromium with a fake serial Worker and a CPU miner. A regtest block mined
# mid-lease checks that the lease survives a new Bitcoin tip.
# macOS arm64 only, like the Hydra runner. Not part of `bun run verify`.
#
# Usage: scripts/rehearse-production-path.sh [--hold | --negatives | --standard-worker]
#   --hold       start the stack, print its configuration and wait instead of the browser run.
#   --standard-worker  run the passing journey with a standard Stratum V1 Worker chosen through the page:
#                the CPU miner takes the settings the page shows, with no Worker Controller.
#   --negatives  run the Gate negatives harness (Ticket 21) and its journey (Ticket 32) in headless
#                Chrome over CDP instead of the passing run. `BWG_TEST_CHROME` overrides the Chrome binary.
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
integration_root=$(mktemp -d)
playwright_cli="$repo_root/node_modules/.bin/playwright-cli"
session_name="bwg-rehearsal-$$"
hold=false
negatives=false
mode=bitaxe
if [[ "${1:-}" == "--hold" ]]; then
  hold=true
elif [[ "${1:-}" == "--negatives" ]]; then
  negatives=true
elif [[ "${1:-}" == "--standard-worker" ]]; then
  mode=standard_worker
elif [[ $# -gt 0 ]]; then
  printf 'Usage: %s [--hold | --negatives | --standard-worker]\n' "$0" >&2
  exit 2
fi

# shellcheck source=scripts/hydra-regtest-stack.sh
source "$repo_root/scripts/hydra-regtest-stack.sh"

harness_pid=""
authority_pid=""
adapter_pid=""
reference_pid=""
server_pid=""
chrome_pid=""
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
  stop_process "$chrome_pid"
  stop_process "$server_pid"
  stop_process "$reference_pid"
  stop_process "$adapter_pid"
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
    for log_path in "$integration_root"/gate-authority.log "$integration_root"/pool-adapter.log "$integration_root"/browser.log "$integration_root"/negatives.log; do
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
cargo build --quiet --all-features --bin gate-authority --bin pool-adapter --bin reference-service \
  --example production-path-rehearsal
front_port=$(free_port)
gate_port=$(free_port)
reference_port=$(free_port)
proxy_port=$(free_port)
authority_grpc_port=$(free_port)
adapter_grpc_port=$(free_port)
origin="https://gate.rehearsal.test:$front_port"
BWG_REHEARSAL_ORIGIN="$origin" \
  BWG_REHEARSAL_GATE_ADDRESS="127.0.0.1:$gate_port" \
  BWG_REHEARSAL_REFERENCE_ADDRESS="127.0.0.1:$reference_port" \
  BWG_REHEARSAL_PROXY_ADDRESS="127.0.0.1:$proxy_port" \
  BWG_REHEARSAL_AUTHORITY_GRPC_ADDRESS="127.0.0.1:$authority_grpc_port" \
  BWG_REHEARSAL_POOL_ADAPTER_GRPC_ADDRESS="127.0.0.1:$adapter_grpc_port" \
  BWG_HYDRA_STRATUM_ADDR="127.0.0.1:$stratum_port" \
  BWG_REHEARSAL_BITCOIN_RPC_URL="http://127.0.0.1:$rpc_port/" \
  BWG_REHEARSAL_BITCOIN_RPC_USER="$rpc_user" \
  BWG_REHEARSAL_BITCOIN_RPC_PASSWORD="$rpc_password" \
  BWG_REHEARSAL_MINING_ADDRESS="$mining_address" \
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
wait_for_port "$authority_grpc_port"
start_binary pool-adapter poolAdapter
adapter_pid=$!
wait_for_port "$adapter_grpc_port"
start_binary reference-service referenceService
reference_pid=$!
wait_for_port "$reference_port"

rehearsal_config=$(jq -c --arg payout "$payout_address" --arg mode "$mode" \
  '{origin, control, authorityTrust, payoutAddress: $payout, mode: $mode}' <<<"$composition")
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

# Runs the Gate negatives harness against a throwaway headless Chrome profile (Ticket 21).
run_negatives() {
  chrome_binary=${BWG_TEST_CHROME:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
  chrome_profile="$integration_root/chrome-profile"
  "$chrome_binary" --headless=new --remote-debugging-port=0 --user-data-dir="$chrome_profile" \
    --no-first-run --no-default-browser-check --ignore-certificate-errors \
    --host-resolver-rules="MAP gate.rehearsal.test 127.0.0.1" about:blank \
    >"$integration_root/chrome.log" 2>&1 &
  chrome_pid=$!
  for _attempt in $(seq 1 300); do
    [[ -s "$chrome_profile/DevToolsActivePort" ]] && break
    sleep 0.1
  done
  if [[ ! -s "$chrome_profile/DevToolsActivePort" ]]; then
    printf 'Chrome did not open its DevTools port\n' >&2
    return 1
  fi
  devtools="ws://127.0.0.1:$(sed -n 1p "$chrome_profile/DevToolsActivePort")$(sed -n 2p "$chrome_profile/DevToolsActivePort")"
  # The harness prints cases, route templates and field names only, so its output can be shown.
  # The journey (Ticket 32) mines and redeems, so the audit also sees Renew grants and the redemption.
  if ! bun scripts/gate-negatives-harness.ts --browser "$devtools" --origin "$origin" --rehearsal \
    --cases withheld,expired_context,handed_over,journey >"$integration_root/negatives.log" 2>&1; then
    printf 'Gate negatives did not pass\n' >&2
    return 1
  fi
  cat "$integration_root/negatives.log"
}

# Every job the Pool Adapter relayed must have passed Hydra's Job Admission (criterion 5).
check_job_admissions() {
  hydra_log_args=()
  for hydra_log in "$integration_root"/hydra-*.log; do
    hydra_log_args+=(--hydra-log "$hydra_log")
  done
  if ! bun scripts/job-admission-evidence.ts --adapter-log "$integration_root/pool-adapter.log" \
    "${hydra_log_args[@]}"; then
    printf 'A relayed job had no accepted Job Admission, or none was relayed\n' >&2
    return 1
  fi
}

# The journey's spent-pass retry gets a 401 for any bad redemption; only the Relying Service's log
# says it was refused because the pass was spent, and that the action ran once (criterion 10).
check_spent_pass() {
  service_log="$integration_root/reference-service.log"
  executions=$(grep -c 'Protected Action succeeded' "$service_log" || true)
  spent_refusals=$(grep -c 'Gate Pass was already consumed' "$service_log" || true)
  printf 'spent pass: %s execution(s), %s refusal(s) as already consumed\n' "$executions" "$spent_refusals"
  if [[ "$executions" != 1 || "$spent_refusals" -lt 1 ]]; then
    printf 'The spent Gate Pass was not refused as consumed, or the action did not run exactly once\n' >&2
    return 1
  fi
}

if [[ "$negatives" == true ]]; then
  run_negatives
  check_job_admissions
  check_spent_pass
  exit 0
fi

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
check_job_admissions
printf 'Production-path rehearsal passed\n'
