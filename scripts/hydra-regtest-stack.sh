#!/usr/bin/env bash
# Pinned regtest Bitcoin Core and Hydra, shared by the Hydra integration runner
# and the production-path rehearsal. Callers set repo_root and integration_root,
# then call prepare_regtest_stack, start_regtest_stack and start_hydra.

bitcoin_pid=""
hydra_pid=""
bitcoin_cli=""
rpc_user=""
rpc_password=""
hydra_run=0

wait_for_process_exit() {
  process_id=$1
  for _attempt in $(seq 1 50); do
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
  if [[ -n "$bitcoin_cli" ]] && [[ -x "$bitcoin_cli" ]]; then
    if ! "$bitcoin_cli" -regtest -rpcconnect=127.0.0.1 -rpcport="$rpc_port" \
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
  for _attempt in $(seq 1 60); do
    if "$bitcoin_cli" -regtest -rpcconnect=127.0.0.1 -rpcport="$rpc_port" \
      -rpcuser="$rpc_user" -rpcpassword="$rpc_password" getblockcount >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  printf 'Bitcoin Core RPC did not become ready\n' >&2
  return 1
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

start_hydra() {
  hydra_run=$((hydra_run + 1))
  RUST_LOG="p2poolv2_lib::stratum::server=info" \
    "$hydra_target_dir/debug/p2poolv2" --config "$config_path" \
    >"$integration_root/hydra-$hydra_run.log" 2>&1 &
  hydra_pid=$!
  wait_for_port "$stratum_port"
}

prepare_regtest_stack() {
  for required in cargo codesign curl git jq nc python3 shasum tar tee; do
    require_command "$required"
  done
  rpc_user="bwg-integration"
  rpc_password=$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')

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

  rpc_port=$(free_port)
  zmq_port=$(free_port)
  stratum_port=$(free_port)
  p2p_port=$(free_port)
  api_port=$(free_port)

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

start_regtest_stack() {

  mkdir "$integration_root/bitcoin-data"
  "$bitcoin_bin/bitcoind" \
    -datadir="$integration_root/bitcoin-data" \
    -regtest -server=1 -listen=0 -txindex=1 -fallbackfee=0.0002 \
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
  sed \
    -e "s|__P2P_PORT__|$p2p_port|g" \
    -e "s|__STORE_PATH__|$integration_root/hydra-store.db|g" \
    -e "s|__STRATUM_PORT__|$stratum_port|g" \
    -e "s|__PAYOUT_ADDRESS__|$payout_address|g" \
    -e "s|__ZMQ_PORT__|$zmq_port|g" \
    -e "s|__RPC_PORT__|$rpc_port|g" \
    -e "s|__RPC_USER__|$rpc_user|g" \
    -e "s|__RPC_PASSWORD__|$rpc_password|g" \
    -e "s|__STATS_PATH__|$integration_root/hydra-stats|g" \
    -e "s|__API_PORT__|$api_port|g" \
    "$repo_root/integration/hydra-solo/config.toml.template" >"$config_path"

}
