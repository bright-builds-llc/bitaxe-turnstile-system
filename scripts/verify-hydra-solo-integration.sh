#!/usr/bin/env bash
# Usage: scripts/verify-hydra-solo-integration.sh [--external-node]
#   --external-node  treat a separately started regtest node as the owner's node:
#                    the mainnet stack must refuse it, and Hydra must run against it
#                    through the external-node path (Ticket 07)
set -euo pipefail

external_node_mode=false
if [[ "${1:-}" == "--external-node" ]]; then
  external_node_mode=true
elif [[ $# -gt 0 ]]; then
  sed -n '2,5p' "$0" >&2
  exit 2
fi

repo_root=$(cd "$(dirname "$0")/.." && pwd)
integration_root=$(mktemp -d)
evidence_root="$repo_root/artifacts/hydra-solo-integration"
evidence_dir="$evidence_root/$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -p "$evidence_dir"
integration_run=0

# shellcheck source=scripts/hydra-regtest-stack.sh
source "$repo_root/scripts/hydra-regtest-stack.sh"
# shellcheck source=scripts/hydra-external-node.sh
source "$repo_root/scripts/hydra-external-node.sh"

cleanup() {
  command_exit=$?
  trap - EXIT INT TERM
  if ! stop_hydra; then
    command_exit=1
  fi
  if ! stop_bitcoind; then
    command_exit=1
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
      stratum::work::coinbase::tests::split_coinbase_halves_hash_to_the_txid_as_stratum_miners_compute_it \
      stratum::work::notify::tests::test_build_notify_and_extract_outputs_integration; do
      run_exact_upstream_test p2poolv2_lib "$test_name"
    done
    for test_name in \
      stratum::message_handlers::submit::block_submission_tests::submission_outcomes_are_explicit_and_do_not_retry_through_gate_services \
      stratum::message_handlers::submit::block_submission_tests::unavailable_bitcoin_core_has_an_explicit_non_gate_outcome \
      stratum::message_handlers::submit::block_submission_tests::hanging_bitcoin_core_is_bounded_by_the_submission_deadline \
      stratum::message_handlers::submit::block_submission_tests::a_found_block_restores_the_coinbase_witness_reserved_value \
      stratum::message_handlers::submit::handle_submit_tests::test_handle_submit_with_stale_job_returns_error \
      stratum::message_handlers::submit::handle_submit_tests::test_handle_submit_duplicate_share_is_rejected \
      stratum::message_handlers::submit::handle_submit_tests::test_p2poolv2_mode_rejects_share_not_meeting_pool_difficulty; do
      run_exact_upstream_test p2poolv2_lib "$test_name"
    done
  } 2>&1 | tee "$integration_root/upstream-admission-tests.log"
}

# The mainnet build has no regtest patch: Hydra's own vardiff tests and its unscaled
# set_difficulty tests pass, and it serializes the difficulty it enforces (Ticket 07).
run_mainnet_build_tests() {
  (
    hydra_build=mainnet
    prepare_pinned_hydra
    for test_name in \
      stratum::messages::tests::test_new_set_difficulty_notification \
      stratum::work::coinbase::tests::split_coinbase_halves_hash_to_the_txid_as_stratum_miners_compute_it \
      stratum::message_handlers::submit::block_submission_tests::a_found_block_restores_the_coinbase_witness_reserved_value \
      stratum::message_handlers::subscribe::tests::test_handle_subscribe_success \
      stratum::difficulty_adjuster::tests::test_difficulty_not_changed_before_minimum_shares \
      stratum::difficulty_adjuster::tests::test_difficulty_adjustment_after_minimum_time \
      stratum::difficulty_adjuster::tests::test_difficulty_adjustment_after_enough_shares \
      stratum::difficulty_adjuster::tests::test_difficulty_adjustment_with_enough_time_delay_to_trigger_adjustment \
      stratum::difficulty_adjuster::tests::test_difficulty_adjustment_with_enough_time_delay_to_trigger_adjustment_start_from_100_000; do
      run_exact_upstream_test p2poolv2_lib "$test_name"
    done
  ) 2>&1 | tee "$integration_root/mainnet-build-tests.log"
}

# Regtest Hydra advertises a scaled difficulty below ESP-Miner's floor, so the
# mainnet guard must refuse it.
verify_mainnet_difficulty_guard_refuses_regtest() {
  guard_log="$integration_root/mainnet-difficulty-guard.log"
  if (hydra_build=mainnet && require_advertised_difficulty) >"$guard_log" 2>&1; then
    printf 'The mainnet difficulty guard accepted regtest Hydra\n' >&2
    return 1
  fi
  if ! grep -Fq 'Hydra advertises difficulty 1e-10; expected 1, at least 0.0001' "$guard_log"; then
    cat "$guard_log" >&2
    return 1
  fi
  printf 'The mainnet difficulty guard refused regtest Hydra\n'
}

external_refusals=0

# Runs the mainnet stack in external-node mode against the stand-in and requires
# EXPECTED_EXIT and MESSAGE, with no credential in its output.
expect_mainnet_refusal() {
  expected_exit=$1
  expected_message=$2
  shift 2
  external_refusals=$((external_refusals + 1))
  refusal_log="$integration_root/mainnet-refusal-$external_refusals.log"
  mkdir "$integration_root/mainnet-$external_refusals"
  refusal_exit=0
  "$repo_root/scripts/hydra-mainnet-stack.sh" --external-node \
    --datadir "$integration_root/mainnet-$external_refusals" --payout-address "$payout_address" \
    "$@" >"$refusal_log" 2>&1 || refusal_exit=$?
  cat "$refusal_log"
  if [[ "$refusal_exit" -ne "$expected_exit" ]] || ! grep -Fq -- "$expected_message" "$refusal_log"; then
    printf 'Mainnet stack refusal %s: expected exit %s with "%s", got exit %s\n' \
      "$external_refusals" "$expected_exit" "$expected_message" "$refusal_exit" >&2
    return 1
  fi
}

verify_external_node_refusals() {
  credentials_path="$integration_root/rpc-credentials.conf"
  wrong_credentials_path="$integration_root/wrong-rpc-credentials.conf"
  (
    umask 077
    printf '# stand-in node\nrpcuser=%s\nrpcpassword=%s\n' "$rpc_user" "$rpc_password" >"$credentials_path"
    printf 'rpcuser=%s\nrpcpassword=not-the-password\n' "$rpc_user" >"$wrong_credentials_path"
  )
  rpc_args=(--rpc-url "http://127.0.0.1:$rpc_port" --zmq-url "tcp://127.0.0.1:$zmq_port")
  expect_mainnet_refusal 1 'the node reports chain regtest, not main' \
    "${rpc_args[@]}" --rpc-credentials-file "$credentials_path"
  expect_mainnet_refusal 1 'refused or did not answer getblockchaininfo' \
    "${rpc_args[@]}" --rpc-credentials-file "$wrong_credentials_path"
  expect_mainnet_refusal 2 '--rpc-url must be http://127.0.0.1:PORT' \
    --rpc-url "http://localhost:$rpc_port" --zmq-url "tcp://127.0.0.1:$zmq_port" \
    --rpc-credentials-file "$credentials_path"
  expect_mainnet_refusal 2 '--external-node needs --rpc-credentials-file' "${rpc_args[@]}"
  expect_mainnet_refusal 2 'bitcoind arguments need a node this script runs' \
    "${rpc_args[@]}" --rpc-credentials-file "$credentials_path" -- -dbcache=100
  chmod 644 "$credentials_path"
  expect_mainnet_refusal 2 'readable only by its owner' \
    "${rpc_args[@]}" --rpc-credentials-file "$credentials_path"
  chmod 600 "$credentials_path"
  # The stack never stops a node it didn't start.
  bitcoin_rpc getblockcount >/dev/null
  printf 'Mainnet stack refused the stand-in node %s times and left it running\n' "$external_refusals"
}

# Hydra through the external-node path: credentials only from the file, the node
# checked by the mainnet stack's own function, on the stand-in's chain.
start_external_node_hydra() {
  rpc_user=""
  rpc_password=""
  load_rpc_credentials "$credentials_path"
  require_external_node regtest
  start_hydra
}

prepare_pinned_stack
if [[ "$external_node_mode" == true ]]; then
  start_regtest_stack
  verify_external_node_refusals
  start_external_node_hydra
  run_integration
else
  run_upstream_admission_tests
  run_mainnet_build_tests
  start_regtest_stack
  require_pruned_without_txindex
  node_is_synced
  start_hydra
  verify_mainnet_difficulty_guard_refuses_regtest
  run_integration
  stop_hydra
  start_hydra
  run_integration
fi

printf 'Verified P2Poolv2 v%s commit %s with Bitcoin Core %s\n' \
  "$p2pool_version" "$p2pool_commit" "$bitcoin_version"
