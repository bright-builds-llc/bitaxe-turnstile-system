#!/usr/bin/env bash
# Mainnet Bitcoin Core and Hydra for Ticket 07, at the same pins as the regtest
# runner. The owner runs it; `bun run verify` never does. Bitcoin Core runs pruned
# without a transaction index, which Hydra and job admission don't need. Hydra
# starts only once the node has left initial block download.
#
# Usage: scripts/hydra-mainnet-stack.sh --datadir DIR --prune MIB --payout-address ADDRESS
#          [--wait-for-sync] [--stratum-port PORT] [-- BITCOIND_ARGS...]
#   --datadir         absolute directory outside the repository; holds bitcoin/ and hydra/
#   --prune           Bitcoin Core's -prune in MiB: 550 or more
#   --payout-address  Hydra's solo and bootstrap address
#   --wait-for-sync   keep the node syncing and start Hydra once it is synced,
#                     instead of refusing while it is still syncing
#   --stratum-port    Hydra's loopback Stratum port (default 3333)
#   -- ARGS           passed to bitcoind, such as -dbcache=4000
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
datadir=""
prune=""
solo_address=""
wait_for_sync=false
hydra_stratum_port=3333
bitcoind_extra_args=()
SYNC_POLL_SECONDS=60

usage() {
  sed -n '7,15p' "$0" >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --datadir) datadir=${2:-}; shift 2 ;;
    --prune) prune=${2:-}; shift 2 ;;
    --payout-address) solo_address=${2:-}; shift 2 ;;
    --wait-for-sync) wait_for_sync=true; shift ;;
    --stratum-port) hydra_stratum_port=${2:-}; shift 2 ;;
    --) shift; bitcoind_extra_args=("$@"); break ;;
    *) usage ;;
  esac
done
if [[ -z "$datadir" || -z "$prune" || -z "$solo_address" ]]; then
  usage
fi
if [[ "$datadir" != /* ]] || [[ ! -d "$datadir" ]]; then
  printf -- '--datadir must be an existing absolute directory\n' >&2
  exit 2
fi
datadir=$(cd "$datadir" && pwd -P)
if [[ "$datadir/" == "$(cd "$repo_root" && pwd -P)/"* ]]; then
  printf -- '--datadir must be outside the repository\n' >&2
  exit 2
fi
if ! [[ "$prune" =~ ^[0-9]+$ ]] || ((prune < 550)); then
  printf -- '--prune must be 550 MiB or more; this stack never runs an unpruned node\n' >&2
  exit 2
fi
if ! [[ "$hydra_stratum_port" =~ ^[0-9]+$ ]]; then
  printf -- '--stratum-port must be a port number\n' >&2
  exit 2
fi

integration_root=$(mktemp -d)
# shellcheck source=scripts/hydra-regtest-stack.sh
source "$repo_root/scripts/hydra-regtest-stack.sh"
bitcoin_chain_arg="-chain=main"
rpc_wait_seconds=1800
process_exit_attempts=3000

cleanup() {
  command_exit=$?
  trap - EXIT INT TERM
  set +e
  if ! stop_hydra; then
    command_exit=1
  fi
  if ! stop_bitcoind; then
    command_exit=1
  fi
  rm -rf "$integration_root"
  exit "$command_exit"
}
trap cleanup EXIT INT TERM

prepare_pinned_stack
mkdir -p "$datadir/bitcoin" "$datadir/hydra"
"$bitcoin_bin/bitcoind" \
  -chain=main -datadir="$datadir/bitcoin" -prune="$prune" -server=1 -listen=0 \
  -rpcuser="$rpc_user" -rpcpassword="$rpc_password" -rpcbind=127.0.0.1 -rpcallowip=127.0.0.1 \
  -rpcport="$rpc_port" -zmqpubhashblock="tcp://127.0.0.1:$zmq_port" \
  "${bitcoind_extra_args[@]}" >"$datadir/bitcoin/bitcoind-console.log" 2>&1 &
bitcoin_pid=$!
wait_for_rpc
require_pruned_without_txindex

until node_is_synced; do
  if [[ "$wait_for_sync" != true ]]; then
    printf 'Refusing to start Hydra while Bitcoin Core is syncing; rerun with --wait-for-sync\n' >&2
    exit 1
  fi
  sleep "$SYNC_POLL_SECONDS"
done

stratum_port=$hydra_stratum_port
config_path="$datadir/hydra/config.toml"
(
  umask 077
  sed \
    -e "s|__P2P_PORT__|$p2p_port|g" \
    -e "s|__STORE_PATH__|$datadir/hydra/store.db|g" \
    -e "s|__STRATUM_PORT__|$stratum_port|g" \
    -e "s|__PAYOUT_ADDRESS__|$solo_address|g" \
    -e "s|__ZMQ_PORT__|$zmq_port|g" \
    -e "s|__RPC_PORT__|$rpc_port|g" \
    -e "s|__RPC_USER__|$rpc_user|g" \
    -e "s|__RPC_PASSWORD__|$rpc_password|g" \
    -e "s|__STATS_PATH__|$datadir/hydra/stats|g" \
    -e "s|__API_PORT__|$api_port|g" \
    "$repo_root/integration/hydra-solo/config.mainnet.toml.template" >"$config_path"
)
integration_root="$datadir/hydra"
start_hydra
printf 'Hydra is serving Stratum on 127.0.0.1:%s; set BWG_POOL_UPSTREAM_STRATUM_ADDRESS to it.\n' \
  "$stratum_port"
printf 'Holding the mainnet stack; press Ctrl-C to stop.\n'
wait "$hydra_pid"
