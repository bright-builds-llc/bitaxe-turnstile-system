#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
integration_root=$(mktemp -d)
evidence_root="$repo_root/artifacts/hydra-solo-integration"
evidence_dir="$evidence_root/$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -p "$evidence_dir"
bitcoin_pid=""
hydra_pid=""
bitcoin_cli=""
rpc_user=""
rpc_password=""
hydra_run=0
integration_run=0

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

cleanup() {
  command_exit=$?
  trap - EXIT INT TERM
  if ! stop_hydra; then
    command_exit=1
  fi
  if [[ -n "$bitcoin_cli" ]] && [[ -x "$bitcoin_cli" ]]; then
    if ! "$bitcoin_cli" -regtest -rpcconnect=127.0.0.1 -rpcport="$rpc_port" \
      -rpcuser="$rpc_user" -rpcpassword="$rpc_password" stop >/dev/null 2>&1; then
      printf 'Bitcoin Core RPC shutdown failed\n' >&2
      command_exit=1
    fi
  fi
  if [[ -n "$bitcoin_pid" ]] && kill -0 "$bitcoin_pid" 2>/dev/null; then
    if ! wait_for_process_exit "$bitcoin_pid"; then
      printf 'Bitcoin Core did not exit after RPC shutdown; sending TERM\n' >&2
      command_exit=1
    fi
  fi
  if [[ -n "$bitcoin_pid" ]] && kill -0 "$bitcoin_pid" 2>/dev/null; then
    if ! kill "$bitcoin_pid"; then
      printf 'Failed to stop Bitcoin Core process %s\n' "$bitcoin_pid" >&2
      command_exit=1
    fi
    if ! wait_for_process_exit "$bitcoin_pid"; then
      printf 'Bitcoin Core did not exit after TERM\n' >&2
      command_exit=1
    fi
  fi
  if [[ -n "$bitcoin_pid" ]] && ! kill -0 "$bitcoin_pid" 2>/dev/null; then
    if wait "$bitcoin_pid" 2>/dev/null; then
      :
    else
      bitcoin_wait_exit=$?
      printf 'Bitcoin Core exited with status %s\n' "$bitcoin_wait_exit" >&2
      command_exit=1
    fi
  fi
  admission_count=0
  for hydra_log_path in "$integration_root"/hydra-*.log; do
    if [[ -f "$hydra_log_path" ]]; then
      if log_admission_count=$(grep -c 'Job admission completed' "$hydra_log_path"); then
        admission_count=$((admission_count + log_admission_count))
      fi
    fi
  done
  block_submission_count=0
  maximum_submission_latency_milliseconds=0
  for block_evidence_path in "$integration_root"/block-submission-*.txt; do
    if [[ -f "$block_evidence_path" ]]; then
      block_submission_count=$((block_submission_count + 1))
      submission_latency=$(awk -F= '$1 == "submission_latency_milliseconds" { print $2 }' "$block_evidence_path")
      if [[ ! "$submission_latency" =~ ^[0-9]+$ ]]; then
        printf 'Invalid block submission latency evidence\n' >&2
        command_exit=1
      elif ((submission_latency > maximum_submission_latency_milliseconds)); then
        maximum_submission_latency_milliseconds=$submission_latency
      fi
    fi
  done
  logs_are_safe=true
  prohibited_values=(
    "${rpc_password:-}"
    "${payout_address:-}"
    "${mining_address:-}"
    "hydra-integration-secret-P9vK2mQ7xR4tY8uN3cF6wL1zA"
  )
  for log_path in "$integration_root"/*.log "$integration_root"/block-submission-*.txt; do
    if [[ -f "$log_path" ]]; then
      for prohibited_value in "${prohibited_values[@]}"; do
        if [[ -n "$prohibited_value" ]] && grep -Fq -- "$prohibited_value" "$log_path"; then
          printf 'Prohibited data detected; omitting integration logs from evidence\n' >&2
          logs_are_safe=false
          command_exit=1
          break 2
        fi
      done
    fi
  done
  if [[ "$logs_are_safe" == true ]]; then
    for log_path in "$integration_root"/*.log "$integration_root"/block-submission-*.txt; do
      if [[ -f "$log_path" ]] && ! cp "$log_path" "$evidence_dir/"; then
        printf 'Failed to preserve integration log %s\n' "$log_path" >&2
        command_exit=1
      fi
    done
  fi
  if ! cp "$repo_root/integration/hydra-solo/provenance.json" "$evidence_dir/"; then
    printf 'Failed to preserve integration provenance\n' >&2
    command_exit=1
  fi
  if [[ "$command_exit" -eq 0 ]]; then
    evidence_status="passed"
  else
    evidence_status="failed"
  fi
  {
    printf 'status=%s\n' "$evidence_status"
    printf 'p2pool_version=%s\n' "${p2pool_version:-unknown}"
    printf 'p2pool_commit=%s\n' "${p2pool_commit:-unknown}"
    printf 'bitcoin_core_version=%s\n' "${bitcoin_version:-unknown}"
    printf 'reward_policy=solo_direct_coinbase\n'
    printf 'selected_destination_basis_points=10000\n'
    printf 'pool_fee_basis_points=0\n'
    printf 'service_fee_basis_points=0\n'
    printf 'bip23_success_result=json_null\n'
    printf 'job_admission_patch_sha256=%s\n' "${p2pool_admission_patch_digest:-unknown}"
    printf 'block_submission_patch_sha256=%s\n' "${p2pool_block_submission_patch_digest:-unknown}"
    printf 'job_admission_acceptances=%s\n' "$admission_count"
    printf 'block_submission_count=%s\n' "$block_submission_count"
    printf 'maximum_submission_latency_milliseconds=%s\n' "$maximum_submission_latency_milliseconds"
    printf 'reorg_exercises=%s\n' "$block_submission_count"
    printf 'completed_at_utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } >"$evidence_dir/summary.txt"
  printf 'Hydra integration evidence: %s\n' "$evidence_dir"
  rm -rf "$integration_root"
  exit "$command_exit"
}
trap cleanup EXIT INT TERM

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

run_integration() {
  integration_run=$((integration_run + 1))
  BWG_HYDRA_STRATUM_ADDR="127.0.0.1:$stratum_port" \
  BWG_HYDRA_PAYOUT_ADDRESS="$payout_address" \
  BWG_BITCOIN_RPC_URL="http://127.0.0.1:$rpc_port" \
  BWG_BITCOIN_RPC_USER="$rpc_user" \
  BWG_BITCOIN_RPC_PASSWORD="$rpc_password" \
  BWG_BITCOIN_MINING_ADDRESS="$mining_address" \
  BWG_BLOCK_SUBMISSION_EVIDENCE_PATH="$integration_root/block-submission-$integration_run.txt" \
    cargo test --manifest-path "$repo_root/Cargo.toml" --all-features \
      --test hydra_solo_integration -- --ignored --nocapture --test-threads=1 \
      2>&1 | tee "$integration_root/integration-$integration_run.log"
  if ! grep -q 'Job admission completed' "$integration_root/hydra-$hydra_run.log"; then
    printf 'Hydra released no BIP 23-admitted job during run %s\n' "$integration_run" >&2
    return 1
  fi
}

run_exact_upstream_test() {
  package=$1
  test_name=$2
  test_output=$(CARGO_TARGET_DIR="$hydra_target_dir" \
    cargo test --manifest-path "$source_dir/Cargo.toml" -p "$package" \
      "$test_name" -- --exact 2>&1)
  printf '%s\n' "$test_output"
  if ! grep -Fq 'test result: ok. 1 passed;' <<<"$test_output"; then
    printf 'Required upstream test did not execute exactly once: %s\n' "$test_name" >&2
    return 1
  fi
}

run_upstream_admission_tests() {
  {
    run_exact_upstream_test p2poolv2_config \
      tests::job_admission_bounds_fail_closed
    run_exact_upstream_test bitcoindrpc tests::test_submit_block
    run_exact_upstream_test bitcoindrpc \
      tests::submit_block_classifies_every_non_success_result
    for test_name in \
      stratum::server::stratum_server_tests::mainnet_cannot_disable_job_admission \
      stratum::server::stratum_server_tests::block_submission_timeout_bounds_are_enforced_at_the_builder_boundary \
      stratum::work::job_admission::tests::deepest_constructor_rejects_out_of_profile_bounds \
      stratum::work::prepared_notify::tests::job_admission_tests::admission_rejects_a_reward_policy_payout_mismatch \
      stratum::work::prepared_notify::tests::job_admission_tests::admission_rejects_a_previous_block_mismatch \
      stratum::work::prepared_notify::tests::job_admission_tests::admission_rejects_a_target_mismatch \
      stratum::work::prepared_notify::tests::job_admission_tests::admission_rejects_a_transaction_mismatch \
      stratum::work::prepared_notify::tests::job_admission_tests::admission_rejects_a_commitment_mismatch \
      stratum::work::prepared_notify::tests::job_admission_tests::admission_rejects_a_coherently_changed_template_witness_commitment \
      stratum::work::prepared_notify::tests::job_admission_tests::admission_rejects_an_invalid_optional_work_id \
      stratum::work::prepared_notify::tests::job_admission_tests::bip23_null_accepts_the_exact_candidate_and_echoes_work_id \
      stratum::work::prepared_notify::tests::job_admission_tests::every_non_null_bip23_result_rejects_the_candidate \
      stratum::work::prepared_notify::tests::job_admission_tests::proposal_timeout_and_unavailability_fail_closed \
      stratum::work::prepared_notify::tests::job_admission_tests::proposal_concurrency_is_bounded_before_bitcoin_core \
      stratum::work::prepared_notify::tests::job_admission_tests::generation_gate_serializes_template_update_with_tracker_and_socket_release \
      stratum::work::prepared_notify::tests::job_admission_tests::superseded_candidate_cannot_publish_or_release_notify_bytes \
      stratum::work::prepared_notify::tests::job_admission_tests::blocked_partial_release_times_out_rolls_back_and_unblocks_templates \
      stratum::work::tracker::tests::new_tip_invalidation_removes_old_jobs_and_their_share_state \
      shares::validation::bitcoin_block_validation::tests::test_validate_bitcoin_block_success \
      shares::validation::bitcoin_block_validation::tests::test_validate_bitcoin_block_reject \
      shares::validation::bitcoin_block_validation::tests::test_validate_bitcoin_block_http_error \
      stratum::work::coinbase::tests::test_building_coinbase_with_regtest_ckpool_data \
      stratum::work::coinbase::tests::test_building_coinbase_with_share_commitment_should_include_the_commitment \
      stratum::work::coinbase::tests::test_extract_outputs_from_coinbase2_integration \
      stratum::work::notify::tests::test_build_notify_and_extract_outputs_integration; do
      run_exact_upstream_test p2poolv2_lib "$test_name"
    done
    for test_name in \
      stratum::message_handlers::submit::block_submission_tests::submission_outcomes_are_explicit_and_do_not_retry_through_gate_services \
      stratum::message_handlers::submit::block_submission_tests::unavailable_bitcoin_core_has_an_explicit_non_gate_outcome \
      stratum::message_handlers::submit::block_submission_tests::hanging_bitcoin_core_is_bounded_by_the_submission_deadline \
      stratum::message_handlers::submit::handle_submit_tests::test_handle_submit_with_stale_job_returns_error \
      stratum::message_handlers::submit::handle_submit_tests::test_handle_submit_duplicate_share_is_rejected \
      stratum::message_handlers::submit::handle_submit_tests::test_p2poolv2_mode_rejects_share_not_meeting_pool_difficulty; do
      run_exact_upstream_test p2poolv2_lib "$test_name"
    done
  } 2>&1 | tee "$integration_root/upstream-admission-tests.log"
}

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
run_upstream_admission_tests

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

start_hydra
run_integration
stop_hydra
start_hydra
run_integration

printf 'Verified P2Poolv2 v%s commit %s with Bitcoin Core %s\n' \
  "$p2pool_version" "$p2pool_commit" "$bitcoin_version"
