#!/usr/bin/env bash
# Pinned Bitcoin Core and Hydra, shared by the Hydra integration runner, the
# production-path rehearsal and the mainnet stack. Callers set repo_root and
# integration_root, then call prepare_pinned_stack; the regtest callers then call
# start_regtest_stack and start_hydra. A caller using a node it didn't start calls
# prepare_pinned_hydra alone and sets rpc_user, rpc_password, rpc_port and zmq_port.

bitcoin_pid=""
hydra_pid=""
bitcoin_cli=""
rpc_user=""
rpc_password=""
hydra_run=0
# The chain every bitcoin-cli call names; the mainnet stack sets `-chain=main`.
bitcoin_chain_arg="-regtest"
# Neither Hydra nor job admission reads the transaction index, so regtest runs
# pruned at Bitcoin Core's minimum without one, like the mainnet node (Ticket 07).
regtest_storage_args=(-prune=550)
# A mainnet node can take minutes to load its index and to flush on shutdown.
rpc_wait_seconds=60
process_exit_attempts=50

wait_for_process_exit() {
  process_id=$1
  for _attempt in $(seq 1 "$process_exit_attempts"); do
    if ! process_state=$(ps -o stat= -p "$process_id"); then
      return 0
    fi
    process_state=${process_state//[[:space:]]/}
    if [[ -z "$process_state" ]] || [[ "$process_state" == Z* ]]; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

stop_hydra() {
  if [[ -z "$hydra_pid" ]] || ! kill -0 "$hydra_pid" 2>/dev/null; then
    hydra_pid=""
    return 0
  fi
  if ! kill "$hydra_pid"; then
    printf 'Failed to stop Hydra process %s\n' "$hydra_pid" >&2
    return 1
  fi
  if wait "$hydra_pid" 2>/dev/null; then
    hydra_pid=""
    return 0
  fi
  hydra_wait_exit=$?
  hydra_pid=""
  if [[ "$hydra_wait_exit" -eq 143 ]]; then
    return 0
  fi
  printf 'Hydra exited unexpectedly during cleanup: %s\n' "$hydra_wait_exit" >&2
  return 1
}


stop_bitcoind() {
  stop_status=0
  # Only a node this stack started is ever told to stop.
  if [[ -z "$bitcoin_pid" ]]; then
    return 0
  fi
  if [[ -n "$bitcoin_cli" ]] && [[ -x "$bitcoin_cli" ]]; then
    if ! "$bitcoin_cli" "$bitcoin_chain_arg" -rpcconnect=127.0.0.1 -rpcport="$rpc_port" \
      -rpcuser="$rpc_user" -rpcpassword="$rpc_password" stop >/dev/null 2>&1; then
      printf 'Bitcoin Core RPC shutdown failed\n' >&2
      stop_status=1
    fi
  fi
  if [[ -n "$bitcoin_pid" ]] && kill -0 "$bitcoin_pid" 2>/dev/null; then
    if ! wait_for_process_exit "$bitcoin_pid"; then
      printf 'Bitcoin Core did not exit after RPC shutdown; sending TERM\n' >&2
      stop_status=1
    fi
  fi
  if [[ -n "$bitcoin_pid" ]] && kill -0 "$bitcoin_pid" 2>/dev/null; then
    if ! kill "$bitcoin_pid"; then
      printf 'Failed to stop Bitcoin Core process %s\n' "$bitcoin_pid" >&2
      stop_status=1
    fi
    if ! wait_for_process_exit "$bitcoin_pid"; then
      printf 'Bitcoin Core did not exit after TERM\n' >&2
      stop_status=1
    fi
  fi
  if [[ -n "$bitcoin_pid" ]] && ! kill -0 "$bitcoin_pid" 2>/dev/null; then
    if wait "$bitcoin_pid" 2>/dev/null; then
      :
    else
      bitcoin_wait_exit=$?
      printf 'Bitcoin Core exited with status %s\n' "$bitcoin_wait_exit" >&2
      stop_status=1
    fi
  fi
  return "$stop_status"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Required command is unavailable: %s\n' "$1" >&2
    exit 1
  fi
}

free_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'
}

download_verified() {
  url=$1
  expected_digest=$2
  destination=$3
  curl --fail --location --silent --show-error --output "$destination" "$url"
  actual_digest=$(shasum -a 256 "$destination" | awk '{print $1}')
  if [[ "$actual_digest" != "$expected_digest" ]]; then
    printf 'Checksum mismatch for %s\n' "$url" >&2
    exit 1
  fi
}

wait_for_rpc() {
  for _attempt in $(seq 1 "$rpc_wait_seconds"); do
    if "$bitcoin_cli" "$bitcoin_chain_arg" -rpcconnect=127.0.0.1 -rpcport="$rpc_port" \
      -rpcuser="$rpc_user" -rpcpassword="$rpc_password" getblockcount >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  printf 'Bitcoin Core RPC did not become ready\n' >&2
  return 1
}

# Fails unless the node is pruned and runs no transaction index, so a passing run
# proves Hydra and job admission need neither.
bitcoin_rpc() {
  "$bitcoin_cli" "$bitcoin_chain_arg" -rpcconnect=127.0.0.1 -rpcport="$rpc_port" \
    -rpcuser="$rpc_user" -rpcpassword="$rpc_password" "$@"
}

require_pruned_without_txindex() {
  chain_info=$(bitcoin_rpc getblockchaininfo)
  index_info=$(bitcoin_rpc getindexinfo)
  if [[ "$(jq -r .pruned <<<"$chain_info")" != "true" ]] || jq -e 'has("txindex")' <<<"$index_info" >/dev/null; then
    printf 'Bitcoin Core must run pruned without a transaction index\n' >&2
    return 1
  fi
  printf 'Bitcoin Core is pruned (prune height %s) with indexes %s\n' \
    "$(jq -r '.pruneheight // 0' <<<"$chain_info")" "$(jq -c 'keys' <<<"$index_info")"
}

# Prints sync progress; succeeds only once the node has left initial block download.
node_is_synced() {
  chain_info=$(bitcoin_rpc getblockchaininfo)
  printf 'Bitcoin Core: %s blocks of %s headers, verification progress %s, initial block download %s\n' \
    "$(jq -r .blocks <<<"$chain_info")" "$(jq -r .headers <<<"$chain_info")" \
    "$(jq -r .verificationprogress <<<"$chain_info")" "$(jq -r .initialblockdownload <<<"$chain_info")"
  [[ "$(jq -r .initialblockdownload <<<"$chain_info")" == "false" ]]
}

wait_for_port() {
  port=$1
  for _attempt in $(seq 1 60); do
    if nc -z 127.0.0.1 "$port" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  printf 'TCP port did not become ready: %s\n' "$port" >&2
  return 1
}

# Hydra reads its RPC credentials from its environment, so they never reach a
# command line or a rendered config.
start_hydra() {
  hydra_run=$((hydra_run + 1))
  P2POOL_BITCOINRPC_USERNAME="$rpc_user" P2POOL_BITCOINRPC_PASSWORD="$rpc_password" \
  RUST_LOG="p2poolv2_lib::stratum::server=info" \
    "$hydra_target_dir/debug/p2poolv2" --config "$config_path" \
    >"$integration_root/hydra-$hydra_run.log" 2>&1 &
  hydra_pid=$!
  wait_for_port "$stratum_port"
}

# Renders TEMPLATE to config_path; Hydra's store and stats go under STATE_DIR.
render_hydra_config() {
  template=$1
  state_dir=$2
  (
    umask 077
    sed \
      -e "s|__P2P_PORT__|$p2p_port|g" \
      -e "s|__STORE_PATH__|$state_dir/hydra-store.db|g" \
      -e "s|__STRATUM_PORT__|$stratum_port|g" \
      -e "s|__PAYOUT_ADDRESS__|$payout_address|g" \
      -e "s|__ZMQ_PORT__|$zmq_port|g" \
      -e "s|__RPC_PORT__|$rpc_port|g" \
      -e "s|__STATS_PATH__|$state_dir/hydra-stats|g" \
      -e "s|__API_PORT__|$api_port|g" \
      "$template" >"$config_path"
  )
}

prepare_pinned_stack() {
  prepare_pinned_hydra
  install_pinned_bitcoin_core
}

# Verifies the pins and patches and builds Hydra; downloads no Bitcoin Core.
prepare_pinned_hydra() {
  for required in cargo codesign curl git jq nc python3 shasum tar tee; do
    require_command "$required"
  done

  if [[ "$(uname -s)" != "Darwin" ]] || [[ "$(uname -m)" != "arm64" ]]; then
    printf 'This pinned integration runner currently supports macOS arm64 only\n' >&2
    exit 1
  fi

  provenance_path="$repo_root/integration/hydra-solo/provenance.json"
  p2pool_version=$(jq -er '.p2poolv2.version' "$provenance_path")
  p2pool_commit=$(jq -er '.p2poolv2.commit' "$provenance_path")
  p2pool_source_url=$(jq -er '.p2poolv2.sourceUrl' "$provenance_path")
  p2pool_source_digest=$(jq -er '.p2poolv2.sourceSha256' "$provenance_path")
  p2pool_patch=$(jq -er '.p2poolv2.regtestPatch' "$provenance_path")
  p2pool_patch_digest=$(jq -er '.p2poolv2.regtestPatchSha256' "$provenance_path")
  p2pool_admission_patch=$(jq -er '.p2poolv2.jobAdmissionPatch' "$provenance_path")
  p2pool_admission_patch_digest=$(jq -er '.p2poolv2.jobAdmissionPatchSha256' "$provenance_path")
  p2pool_block_submission_patch=$(jq -er '.p2poolv2.blockSubmissionPatch' "$provenance_path")
  p2pool_block_submission_patch_digest=$(jq -er '.p2poolv2.blockSubmissionPatchSha256' "$provenance_path")
  bitcoin_version=$(jq -er '.bitcoinCore.version' "$provenance_path")
  bitcoin_source_url=$(jq -er '.bitcoinCore.sourceUrl' "$provenance_path")
  bitcoin_source_digest=$(jq -er '.bitcoinCore.sha256' "$provenance_path")
  patch_path="$repo_root/integration/hydra-solo/$p2pool_patch"
  admission_patch_path="$repo_root/integration/hydra-solo/$p2pool_admission_patch"
  block_submission_patch_path="$repo_root/integration/hydra-solo/$p2pool_block_submission_patch"
  actual_patch_digest=$(shasum -a 256 "$patch_path" | awk '{print $1}')
  if [[ "$actual_patch_digest" != "$p2pool_patch_digest" ]]; then
    printf 'Checksum mismatch for %s\n' "$patch_path" >&2
    exit 1
  fi
  actual_admission_patch_digest=$(shasum -a 256 "$admission_patch_path" | awk '{print $1}')
  if [[ "$actual_admission_patch_digest" != "$p2pool_admission_patch_digest" ]]; then
    printf 'Checksum mismatch for %s\n' "$admission_patch_path" >&2
    exit 1
  fi
  actual_block_submission_patch_digest=$(shasum -a 256 "$block_submission_patch_path" | awk '{print $1}')
  if [[ "$actual_block_submission_patch_digest" != "$p2pool_block_submission_patch_digest" ]]; then
    printf 'Checksum mismatch for %s\n' "$block_submission_patch_path" >&2
    exit 1
  fi

  stratum_port=$(free_port)
  p2p_port=$(free_port)
  api_port=$(free_port)

  source_archive="$integration_root/p2poolv2-source.tar.gz"
  download_verified \
    "$p2pool_source_url" \
    "$p2pool_source_digest" \
    "$source_archive"
  mkdir "$integration_root/source"
  tar -xzf "$source_archive" -C "$integration_root/source"
  source_dir=$(find "$integration_root/source" -mindepth 1 -maxdepth 1 -type d | head -1)
  git -C "$source_dir" apply "$patch_path"
  git -C "$source_dir" apply "$admission_patch_path"
  git -C "$source_dir" apply "$block_submission_patch_path"
  hydra_target_dir="$repo_root/target/hydra-v$p2pool_version"
  CARGO_TARGET_DIR="$hydra_target_dir" \
    cargo build --manifest-path "$source_dir/Cargo.toml" -p p2poolv2_node --bin p2poolv2
}

# Downloads the pinned Bitcoin Core and picks its RPC credentials and ports.
install_pinned_bitcoin_core() {
  rpc_user="bwg-integration"
  rpc_password=$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')
  rpc_port=$(free_port)
  zmq_port=$(free_port)

  bitcoin_archive="$integration_root/bitcoin.tar.gz"
  download_verified \
    "$bitcoin_source_url" \
    "$bitcoin_source_digest" \
    "$bitcoin_archive"
  tar -xzf "$bitcoin_archive" -C "$integration_root"
  bitcoin_bin="$integration_root/bitcoin-$bitcoin_version/bin"
  bitcoin_cli="$bitcoin_bin/bitcoin-cli"
  for binary in "$bitcoin_bin/bitcoind" "$bitcoin_cli"; do
    if xattr -p com.apple.provenance "$binary" >/dev/null 2>&1; then
      xattr -d com.apple.provenance "$binary"
    fi
    codesign --force --sign - "$binary"
  done
}

start_regtest_stack() {

  mkdir "$integration_root/bitcoin-data"
  "$bitcoin_bin/bitcoind" \
    -datadir="$integration_root/bitcoin-data" \
    -regtest -server=1 -listen=0 "${regtest_storage_args[@]}" -fallbackfee=0.0002 \
    -rpcuser="$rpc_user" -rpcpassword="$rpc_password" -rpcbind=127.0.0.1 -rpcallowip=127.0.0.1 \
    -rpcport="$rpc_port" -zmqpubhashblock="tcp://127.0.0.1:$zmq_port" \
    -printtoconsole >"$integration_root/bitcoind.log" 2>&1 &
  bitcoin_pid=$!
  wait_for_rpc

  bitcoin_args=(-regtest -rpcconnect=127.0.0.1 -rpcport="$rpc_port" -rpcuser="$rpc_user" -rpcpassword="$rpc_password")
  "$bitcoin_cli" "${bitcoin_args[@]}" createwallet integration >/dev/null
  payout_address="1BoatSLRHtKNngkdXEeobR76b53LETtpyT"
  mining_address=$("$bitcoin_cli" "${bitcoin_args[@]}" -rpcwallet=integration getnewaddress)
  "$bitcoin_cli" "${bitcoin_args[@]}" -rpcwallet=integration \
    generatetoaddress 32 "$mining_address" >/dev/null

  config_path="$integration_root/hydra-config.toml"
  render_hydra_config "$repo_root/integration/hydra-solo/config.toml.template" "$integration_root"
}
