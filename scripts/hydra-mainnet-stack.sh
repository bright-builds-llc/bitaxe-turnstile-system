#!/usr/bin/env bash
# Mainnet Hydra for Ticket 07, at the same pins as the regtest runner. The owner
# runs it; `bun run verify` never does. Hydra starts only once Bitcoin Core reports
# that it has left initial block download.
#
# Usage, with a node this script runs (pruned, without a transaction index):
#   scripts/hydra-mainnet-stack.sh --datadir DIR --prune MIB --payout-address ADDRESS
#     [--wait-for-sync] [--stratum-port PORT] [-- BITCOIND_ARGS...]
# Usage, with a synced node the owner already runs, reached on loopback:
#   scripts/hydra-mainnet-stack.sh --external-node --datadir DIR --rpc-url URL
#     --zmq-url URL --rpc-credentials-file FILE --payout-address ADDRESS [--stratum-port PORT]
# Either usage may take --payout-from-pool-user FILE in place of --payout-address.
#
#   --datadir               absolute directory outside the repository; holds bitcoin/ and hydra/
#   --prune                 Bitcoin Core's -prune in MiB: 550 or more
#   --payout-address        Hydra's solo and bootstrap address
#   --payout-from-pool-user JSON file whose poolUser, up to its first dot, is that
#                           address; it is never printed
#   --wait-for-sync         keep the node syncing and start Hydra once it is synced
#   --stratum-port          Hydra's loopback Stratum port (default 3333)
#   --external-node         use a running node; download and start no Bitcoin Core
#   --rpc-url               http://127.0.0.1:PORT, the node's RPC
#   --zmq-url               tcp://127.0.0.1:PORT, the node's zmqpubhashblock
#   --rpc-credentials-file  owner-only file outside the repository with rpcuser= and
#                           rpcpassword= lines
#   -- ARGS                 passed to bitcoind, such as -dbcache=4000
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
datadir=""
prune=""
payout_address=""
wait_for_sync=false
hydra_stratum_port=3333
external_node=false
rpc_url=""
zmq_url=""
credentials_path=""
pool_user_path=""
bitcoind_extra_args=()
SYNC_POLL_SECONDS=60

usage() {
  sed -n '6,26p' "$0" >&2
  exit 2
}

refuse_usage() {
  printf '%s\n' "$1" >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --datadir) datadir=${2:-}; shift 2 ;;
    --prune) prune=${2:-}; shift 2 ;;
    --payout-address) payout_address=${2:-}; shift 2 ;;
    --payout-from-pool-user) pool_user_path=${2:-}; shift 2 ;;
    --wait-for-sync) wait_for_sync=true; shift ;;
    --stratum-port) hydra_stratum_port=${2:-}; shift 2 ;;
    --external-node) external_node=true; shift ;;
    --rpc-url) rpc_url=${2:-}; shift 2 ;;
    --zmq-url) zmq_url=${2:-}; shift 2 ;;
    --rpc-credentials-file) credentials_path=${2:-}; shift 2 ;;
    --) shift; bitcoind_extra_args=("$@"); break ;;
    *) usage ;;
  esac
done
if [[ -n "$pool_user_path" ]]; then
  if [[ -n "$payout_address" ]]; then
    refuse_usage '--payout-address and --payout-from-pool-user are exclusive'
  fi
  if ! pool_user=$(jq -er '.poolUser' "$pool_user_path" 2>/dev/null); then
    refuse_usage '--payout-from-pool-user needs a readable JSON file with a poolUser'
  fi
  payout_address=${pool_user%%.*}
  if ! [[ "$payout_address" =~ ^[A-Za-z0-9]{26,90}$ ]]; then
    refuse_usage 'the poolUser does not start with a Bitcoin address'
  fi
fi
if [[ -z "$datadir" || -z "$payout_address" ]]; then
  usage
fi
if [[ "$datadir" != /* ]] || [[ ! -d "$datadir" ]]; then
  refuse_usage '--datadir must be an existing absolute directory'
fi
datadir=$(cd "$datadir" && pwd -P)
if [[ "$datadir/" == "$(cd "$repo_root" && pwd -P)/"* ]]; then
  refuse_usage '--datadir must be outside the repository'
fi
if ! [[ "$hydra_stratum_port" =~ ^[0-9]+$ ]]; then
  refuse_usage '--stratum-port must be a port number'
fi

integration_root=$(mktemp -d)
# Hydra later logs under the datadir; only this scratch directory is removed.
scratch_root=$integration_root
# shellcheck source=scripts/hydra-regtest-stack.sh
source "$repo_root/scripts/hydra-regtest-stack.sh"
# shellcheck source=scripts/hydra-external-node.sh
source "$repo_root/scripts/hydra-external-node.sh"
bitcoin_chain_arg="-chain=main"
hydra_build=mainnet
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
  rm -rf "$scratch_root"
  exit "$command_exit"
}
trap cleanup EXIT INT TERM

start_owned_node() {
  if [[ -n "$rpc_url$zmq_url$credentials_path" ]]; then
    refuse_usage '--rpc-url, --zmq-url and --rpc-credentials-file need --external-node'
  fi
  if ! [[ "$prune" =~ ^[0-9]+$ ]] || ((prune < 550)); then
    refuse_usage '--prune must be 550 MiB or more; this stack never runs an unpruned node'
  fi
  prepare_pinned_stack
  mkdir -p "$datadir/bitcoin"
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
}

# The node is checked before the Hydra build, for a fast refusal, and again just
# before Hydra starts.
use_external_node() {
  if [[ -n "$prune" || "$wait_for_sync" == true || ${#bitcoind_extra_args[@]} -gt 0 ]]; then
    refuse_usage '--prune, --wait-for-sync and bitcoind arguments need a node this script runs'
  fi
  if ! rpc_port=$(loopback_port http "$rpc_url"); then
    refuse_usage '--rpc-url must be http://127.0.0.1:PORT; reach a remote node through a tunnel'
  fi
  if ! zmq_port=$(loopback_port tcp "$zmq_url"); then
    refuse_usage '--zmq-url must be tcp://127.0.0.1:PORT; reach a remote node through a tunnel'
  fi
  if [[ -z "$credentials_path" ]]; then
    refuse_usage '--external-node needs --rpc-credentials-file'
  fi
  load_rpc_credentials "$credentials_path" || exit $?
  for required in curl jq; do
    require_command "$required"
  done
  require_external_node main
  prepare_pinned_hydra
  require_external_node main
}

if [[ "$external_node" == true ]]; then
  use_external_node
else
  start_owned_node
fi

stratum_port=$hydra_stratum_port
mkdir -p "$datadir/hydra"
config_path="$datadir/hydra/config.toml"
render_hydra_config "$repo_root/integration/hydra-solo/config.mainnet.toml.template" "$datadir/hydra"
integration_root="$datadir/hydra"
start_hydra
printf 'Hydra is serving Stratum on 127.0.0.1:%s; set BWG_POOL_UPSTREAM_STRATUM_ADDRESS to it.\n' \
  "$stratum_port"
printf 'Holding the mainnet stack; press Ctrl-C to stop.\n'
wait "$hydra_pid"
