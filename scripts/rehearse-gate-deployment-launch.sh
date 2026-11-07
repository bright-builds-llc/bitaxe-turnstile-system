#!/usr/bin/env bash
# Proves scripts/launch-gate-deployment.sh on regtest with generated test keys
# (Ticket 07). It stands up pinned Bitcoin Core and Hydra, generates Gate keys with
# scripts/gate-deployment-keys.ts and a Work Lease Authority with
# scripts/worker-development-authority.ts, and fakes a C image's digests. It checks
# the launcher's refusals, the seeded lease sequence, the filled page config, the
# front's routes, the recorded high-water mark and the logs.
# macOS arm64 only, like the Hydra runner. Not part of `bun run verify`.
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
integration_root=$(mktemp -d)
# shellcheck source=scripts/hydra-regtest-stack.sh
source "$repo_root/scripts/hydra-regtest-stack.sh"

STORED_SEQUENCE=700
SEQUENCE_MARGIN=1000
ORIGIN="https://gate.launch.test"
launcher_pid=""
proof_root="$integration_root/proof"

cleanup() {
  command_exit=$?
  trap - EXIT INT TERM
  set +e
  if [[ -n "$launcher_pid" ]] && kill -0 "$launcher_pid" 2>/dev/null; then
    kill "$launcher_pid"
    wait "$launcher_pid"
  fi
  stop_hydra || command_exit=1
  stop_bitcoind || command_exit=1
  if ((command_exit != 0)); then
    for log_path in "$proof_root"/launcher*.log "$proof_root"/run/*.log; do
      [[ -s "$log_path" ]] && { printf '%s:\n' "$log_path" >&2; tail -n 40 "$log_path" >&2; }
    done
  fi
  rm -rf "$integration_root"
  exit "$command_exit"
}
trap cleanup EXIT INT TERM

fail() {
  printf 'Gate deployment launch proof failed: %s\n' "$1" >&2
  exit 1
}

prepare_pinned_stack
start_regtest_stack
start_hydra

# Test inputs, standing in for the owner's files.
mkdir -p "$proof_root"
keys_dir="$proof_root/keys"
lease_dir="$proof_root/lease-authority"
image_dir="$proof_root/image"
bun "$repo_root/scripts/gate-deployment-keys.ts" --directory "$keys_dir" >"$proof_root/keys.json"
bun "$repo_root/scripts/worker-development-authority.ts" init --directory "$lease_dir" >/dev/null
lease_kid=$(jq -er .activeKid "$lease_dir/lease-private.json")
(
  umask 077
  jq --arg kid "$lease_kid" --arg sequence "$STORED_SEQUENCE" '.sequences[$kid] = $sequence' \
    "$lease_dir/lease-sequence.json" >"$lease_dir/lease-sequence.next"
)
mv "$lease_dir/lease-sequence.next" "$lease_dir/lease-sequence.json"
mkdir "$image_dir"
image_commit=$(python3 -c 'import secrets; print(secrets.token_hex(20))')
elf_digest=$(python3 -c 'import secrets; print(secrets.token_hex(32))')
printf '%s\n' "$image_commit" >"$image_dir/COMMIT"
printf '%s  bootloader.bin\n%s  esp-miner.elf\n' "$(python3 -c 'import secrets; print(secrets.token_hex(32))')" \
  "$elf_digest" >"$image_dir/SHA256SUMS"
proxy_port=$(free_port)

launch_args=(
  --keys-dir "$keys_dir" --lease-authority-dir "$lease_dir" --owner-trust "$lease_dir/trust.json"
  --image-dir "$image_dir" --run-dir "$proof_root/run" --upstream "127.0.0.1:$stratum_port"
  --proxy-port "$proxy_port" --sequence-margin "$SEQUENCE_MARGIN"
  --proxy-address 127.0.0.1 --loopback-origin "$ORIGIN"
)

expect_refusal() {
  expected_message=$1
  shift
  refusal_exit=0
  "$repo_root/scripts/launch-gate-deployment.sh" "$@" >"$proof_root/launcher-refusal.log" 2>&1 || refusal_exit=$?
  if ((refusal_exit != 2)) || ! grep -Fq -- "$expected_message" "$proof_root/launcher-refusal.log"; then
    cat "$proof_root/launcher-refusal.log" >&2
    fail "expected exit 2 with \"$expected_message\", got exit $refusal_exit"
  fi
  if docker ps --format '{{.Names}}' | grep -q '^bwg-gate-deployment-'; then
    fail "a refused launch left PostgreSQL running"
  fi
  printf 'Launcher refused: %s\n' "$expected_message"
}

# Fails closed on an unreadable sequence file and a lease key the trust doesn't name.
chmod 000 "$lease_dir/lease-sequence.json"
expect_refusal 'lease-sequence.json is missing or unreadable' "${launch_args[@]}"
chmod 600 "$lease_dir/lease-sequence.json"
foreign_trust_args=("${launch_args[@]}")
foreign_trust_args[5]="$repo_root/conformance/bwg-worker-deployment-trust-0.2/trust.json"
expect_refusal "the active lease key $lease_kid is not in the owner trust" "${foreign_trust_args[@]}"
chmod 644 "$keys_dir/service-credential.json"
expect_refusal 'service-credential.json must be readable only by its owner' "${launch_args[@]}"
chmod 600 "$keys_dir/service-credential.json"

"$repo_root/scripts/launch-gate-deployment.sh" "${launch_args[@]}" >"$proof_root/launcher.log" 2>&1 &
launcher_pid=$!
for _attempt in $(seq 1 1800); do
  grep -q '^gate_deployment=ready' "$proof_root/launcher.log" 2>/dev/null && break
  kill -0 "$launcher_pid" 2>/dev/null || fail "the launcher exited before it was ready"
  sleep 0.2
done
ready_line=$(grep '^gate_deployment=ready' "$proof_root/launcher.log") || fail "the launcher never became ready"
front_port=$(sed -n 's/.*front_port=\([0-9]*\).*/\1/p' <<<"$ready_line")
postgres_container=$(sed -n 's/.*postgres_container=\([^ ]*\).*/\1/p' <<<"$ready_line")
front="http://127.0.0.1:$front_port"

# The lease sequence starts above the stored value plus the margin.
seeded=$(docker exec "$postgres_container" psql -h 127.0.0.1 -U bwg -d gate_authority -tAc \
  "SELECT last_sequence FROM gate_authority.work_lease_authorization_sequences WHERE key_id = '$lease_kid'")
[[ "$seeded" == "$((STORED_SEQUENCE + SEQUENCE_MARGIN))" ]] || fail "lease sequence seeded at $seeded"
printf 'Lease sequence for %s seeded at %s\n' "$lease_kid" "$seeded"

# The page carries the generated Gate Pass keys, the owner trust's Update Authority
# keys and the image's digests.
curl --fail --silent "$front/reference/account-creation.html" >"$proof_root/page.html"
page_config=$(sed -n 's/.*<script type="application\/json" id="bwg-reference-config">\(.*\)<\/script>.*/\1/p' \
  "$proof_root/page.html")
jq -e --arg origin "$ORIGIN" --arg commit "$image_commit" --arg elf "$elf_digest" \
  --slurpfile keys "$keys_dir/gate-pass-public-keys.json" --slurpfile trust "$lease_dir/trust.json" '
  .authorityTrust == { issuer: $origin, trustedKeys: $keys[0] }
  and .worker.trustedUpdateKeys == $trust[0].updateAuthority.keys
  and .worker.expectedFirmwareSourceCommit == $commit
  and .worker.expectedAppElfSha256 == $elf
  and .worker.deviceFilter == { usbVendorId: 12346, usbProductId: 4097 }
  and (.claimantWorkCeiling | tonumber) >= 17592186044416
  and (.clientSafetyCeiling | tonumber) >= 17592186044416' <<<"$page_config" >/dev/null ||
  fail "the page config does not match its inputs: $page_config"
printf 'Page config matches the generated keys, the trust and the image digests\n'

# The Authority publishes the generated key through the front.
signing_kid=$(jq -er .kid "$proof_root/keys.json")
curl --fail --silent "$front/.well-known/jwks.json" | jq -e --arg kid "$signing_kid" 'any(.keys[]; .kid == $kid)' >/dev/null ||
  fail "the Authority does not publish $signing_kid"
for path in /reference/production-path-rehearsal.html /dist/test-rehearsal/production-path-rehearsal-entry.js /package.json /scripts/launch-gate-deployment.sh; do
  status=$(curl --silent --output /dev/null --write-out '%{http_code}' "$front$path")
  [[ "$status" == "404" ]] || fail "the front served $path with $status"
done
printf 'The front publishes the Gate Pass key and serves nothing beyond the page\n'

# The Reference Relying Service creates a challenge with the generated service
# credential, so the production environment and both binaries agree on the origin.
claimant_key='{"kty":"EC","crv":"P-256","x":"l8tFrhx-34tV3hRICRDY9zCkDlpBhF42UQUfWVAWBFs","y":"9VE4jf_Ok_o64zbTTlcuNJajHmt6v9TDVrU0CdvGRDA"}'
challenge_status=$(curl --silent --output "$proof_root/challenge.json" --write-out '%{http_code}' \
  --header 'content-type: application/json' --header "origin: $ORIGIN" \
  --data "$(jq -cn --arg key "$claimant_key" '{claimant_key: $key}')" "$front/account-creation/challenge")
[[ "$challenge_status" == "201" ]] || fail "challenge creation returned $challenge_status"
jq -e --arg origin "$ORIGIN" '(.challenge_id | type == "string") and .relying_service_audience == $origin' \
  "$proof_root/challenge.json" >/dev/null || fail "the challenge descriptor does not name the origin"
printf 'A challenge was created through the front with the generated service credential\n'

# Background jobs ignore SIGINT; TERM is the same normal stop as Ctrl-C.
kill -TERM "$launcher_pid"
launcher_exit=0
wait "$launcher_pid" || launcher_exit=$?
launcher_pid=""
((launcher_exit == 0)) || fail "the launcher stopped with exit $launcher_exit"
if docker ps -a --format '{{.Names}}' | grep -qx "$postgres_container"; then
  fail "the launcher left PostgreSQL behind"
fi
recorded=$(jq -er --arg kid "$lease_kid" '.sequences[$kid]' "$lease_dir/lease-sequence.json")
[[ "$recorded" == "$seeded" ]] || fail "the high-water mark recorded as $recorded"
(((8#$(stat -f '%Lp' "$lease_dir/lease-sequence.json") & 8#077) == 0)) || fail "lease-sequence.json lost its mode"
printf 'Lease sequence high-water mark %s recorded; PostgreSQL removed\n' "$recorded"

secrets=(
  "$(jq -r .seed "$keys_dir/gate-pass-signing.json")"
  "$(jq -r .credential "$keys_dir/service-credential.json")"
  "$(jq -r .key "$keys_dir/stratum-credential-key.json")"
  "$(jq -r --arg kid "$lease_kid" '.keys[] | select(.kid == $kid) | .d' "$lease_dir/lease-private.json")"
)
for log_path in "$proof_root"/launcher.log "$proof_root"/run/*.log; do
  for secret in "${secrets[@]}"; do
    if grep -Fq -- "$secret" "$log_path"; then
      fail "$(basename "$log_path") holds a private value"
    fi
  done
done
# The terminal shows the owner the origin; the run's logs name neither it nor the LAN address.
for log_path in "$proof_root"/run/*.log; do
  if grep -Fq -- "${ORIGIN#https://}" "$log_path"; then
    fail "$(basename "$log_path") names the origin host"
  fi
done
grep -q 'LAN_ADDRESS' "$proof_root/run/gate-authority.log" || fail "the proxy address was not redacted"
printf 'No private value in the logs; the run logs redact the origin host and the LAN address\n'
printf 'Gate deployment launch proof passed\n'
