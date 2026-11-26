#!/usr/bin/env bash
# The one supported launch path for a self-hosted reference deployment (bwg-core Ticket 24).
# It validates a `bwg-self-host/0.1` configuration, starts pinned Hydra, then runs the same
# launcher as the owner's deployment (`scripts/launch-gate-deployment.sh`) with the flags the
# configuration names. On regtest it also starts its own Bitcoin Core; on mainnet Hydra uses the
# self-hoster's synced node. Ctrl-C stops everything. macOS arm64 only, like the pinned runners.
# The runbook is docs/operations/self-hosted-deployment.md.
#
# Usage: scripts/self-host-gate.sh --config FILE
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd -P)
config_path=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config) config_path=${2:-}; shift 2 ;;
    *) printf 'Usage: %s --config FILE\n' "$0" >&2; exit 2 ;;
  esac
done
[[ -n "$config_path" ]] || { printf 'Usage: %s --config FILE\n' "$0" >&2; exit 2; }

refuse() {
  printf 'Refusing to self-host: %s\n' "$1" >&2
  exit 2
}

[[ -r "$config_path" ]] || refuse "$config_path is unreadable"
plan=$(bun "$repo_root/scripts/self-host-config.ts" --config "$config_path") || exit 2
network=$(jq -er '.network' <<<"$plan")
operator_address=$(jq -er '.operatorAddress' <<<"$plan")
launcher_args=()
while IFS= read -r -d '' argument; do
  launcher_args+=("$argument")
done < <(jq -j '.launcherArguments[] | "\(.)\u0000"' <<<"$plan")

integration_root=$(mktemp -d)
mainnet_stack_pid=""
launcher_pid=""
# shellcheck source=scripts/hydra-regtest-stack.sh
source "$repo_root/scripts/hydra-regtest-stack.sh"

cleanup() {
  command_exit=$?
  trap - EXIT INT TERM
  set +e
  if [[ -n "$launcher_pid" ]] && kill -0 "$launcher_pid" 2>/dev/null; then
    kill -TERM "$launcher_pid"
    wait "$launcher_pid" || command_exit=1
  fi
  if [[ -n "$mainnet_stack_pid" ]] && kill -0 "$mainnet_stack_pid" 2>/dev/null; then
    kill -TERM "$mainnet_stack_pid"
    wait "$mainnet_stack_pid"
  fi
  if [[ "$network" == regtest ]]; then
    stop_hydra || command_exit=1
    stop_bitcoind || command_exit=1
  fi
  rm -rf "$integration_root"
  exit "$command_exit"
}
trap cleanup EXIT
trap 'exit 0' INT TERM

if [[ "$network" == regtest ]]; then
  prepare_pinned_stack
  start_regtest_stack
  # Hydra pays its solo and bootstrap address; the configuration names it, as on mainnet.
  payout_address=$operator_address
  start_hydra
  upstream="127.0.0.1:$stratum_port"
else
  hydra_stratum_port=$(free_port)
  "$repo_root/scripts/hydra-mainnet-stack.sh" --external-node \
    --datadir "$(jq -er '.node.datadir' <<<"$plan")" \
    --rpc-url "$(jq -er '.node.rpcUrl' <<<"$plan")" --zmq-url "$(jq -er '.node.zmqUrl' <<<"$plan")" \
    --rpc-credentials-file "$(jq -er '.node.rpcCredentialsFile' <<<"$plan")" \
    --payout-address "$operator_address" --stratum-port "$hydra_stratum_port" &
  mainnet_stack_pid=$!
  for _attempt in $(seq 1 1800); do
    nc -z 127.0.0.1 "$hydra_stratum_port" >/dev/null 2>&1 && break
    kill -0 "$mainnet_stack_pid" 2>/dev/null || refuse 'the mainnet Hydra stack exited before it listened'
    sleep 1
  done
  nc -z 127.0.0.1 "$hydra_stratum_port" >/dev/null 2>&1 || refuse 'Hydra never listened'
  upstream="127.0.0.1:$hydra_stratum_port"
fi

"$repo_root/scripts/launch-gate-deployment.sh" "${launcher_args[@]}" --upstream "$upstream" &
launcher_pid=$!
launcher_exit=0
wait "$launcher_pid" || launcher_exit=$?
launcher_pid=""
exit "$launcher_exit"
