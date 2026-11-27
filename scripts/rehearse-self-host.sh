#!/usr/bin/env bash
# Proves the self-hosted reference deployment (bwg-core Ticket 24) on regtest with generated
# test keys. It checks the configuration's refusals and a launch that never becomes ready, then
# upgrades: it launches UPGRADE_FROM, the first self-hostable commit, from a temporary worktree,
# then this tree on the same volume, through scripts/self-host-gate.sh, the one supported launch
# path, behind a throwaway TLS proxy standing in for the self-hoster's. It checks the migrations,
# the health, readiness and provenance routes, then drives the deployment's own page in a headless
# Chrome as a claimant with a standard Stratum V1 Worker (scripts/self-host-journey.ts). Then it
# backs the databases up while running, restores them into a new volume and relaunches on it.
# Last, it rotates the Gate Pass key (beside the old one, then alone) and the Work Lease key.
# macOS arm64 only, like the Hydra runner. Not part of `bun run verify`.
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd -P)
integration_root=$(mktemp -d)
proof_root="$integration_root/proof"
ORIGIN_HOST="gate.selfhost.test"
ORIGIN="https://$ORIGIN_HOST"
OPERATOR_ADDRESS="1BoatSLRHtKNngkdXEeobR76b53LETtpyT"
READINESS_FAILURE_TIMEOUT=20
# The first commit with the self-host launch path; every later migration upgrades from it.
UPGRADE_FROM=1eda7d520b390cc52b9811e14f39b839e2af37f5
CLAIMANT_KEY='{"kty":"EC","crv":"P-256","x":"l8tFrhx-34tV3hRICRDY9zCkDlpBhF42UQUfWVAWBFs","y":"9VE4jf_Ok_o64zbTTlcuNJajHmt6v9TDVrU0CdvGRDA"}'
upgrade_source="$integration_root/upgrade-from"
upgrade_worktree_added=false
volume="bwg-self-host-proof-$$"
restored_volume="bwg-self-host-restored-$$"
refused_volume="bwg-self-host-refused-$$"
self_host_pid=""
miner_pid=""
proxy_pid=""
chrome_pid=""
silent_pool_pid=""

stop_process() {
  if [[ -n "$1" ]] && kill -0 "$1" 2>/dev/null; then
    kill -TERM "$1"
    wait "$1"
  fi
}

cleanup() {
  command_exit=$?
  trap - EXIT INT TERM
  set +e
  stop_process "$chrome_pid"
  stop_process "$silent_pool_pid"
  stop_process "$proxy_pid"
  stop_process "$miner_pid"
  stop_process "$self_host_pid" || command_exit=1
  for name in "$volume" "$restored_volume" "$refused_volume"; do
    if docker volume inspect "$name" >/dev/null 2>&1; then
      docker volume rm "$name" >/dev/null || command_exit=1
    fi
  done
  if ((command_exit != 0)); then
    for log_path in "$proof_root"/*.log "$proof_root"/run*/*.log; do
      [[ -s "$log_path" ]] && { printf '%s:\n' "$log_path" >&2; tail -n 40 "$log_path" >&2; }
    done
  fi
  if [[ "$upgrade_worktree_added" == true ]]; then
    git -C "$repo_root" worktree remove --force "$upgrade_source" || command_exit=1
  fi
  rm -rf "$integration_root"
  exit "$command_exit"
}
trap cleanup EXIT INT TERM

fail() {
  printf 'Self-host proof failed: %s\n' "$1" >&2
  exit 1
}

free_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'
}

# Test inputs, standing in for the self-hoster's files.
mkdir -p "$proof_root"
keys_dir="$proof_root/keys"
lease_dir="$proof_root/lease-authority"
image_dir="$proof_root/image"
bun "$repo_root/scripts/gate-deployment-keys.ts" --directory "$keys_dir" >/dev/null
bun "$repo_root/scripts/worker-development-authority.ts" init --directory "$lease_dir" >/dev/null
mkdir "$image_dir"
python3 -c 'import secrets; print(secrets.token_hex(20))' >"$image_dir/COMMIT"
printf '%s  bootloader.bin\n%s  esp-miner.elf\n' "$(python3 -c 'import secrets; print(secrets.token_hex(32))')" \
  "$(python3 -c 'import secrets; print(secrets.token_hex(32))')" >"$image_dir/SHA256SUMS"
front_port=$(free_port)

# Writes a regtest configuration for VOLUME and RUN_DIR, with a fresh proxy port and jq FILTER applied.
write_config() {
  jq -n --arg front_port "$front_port" --arg proxy_port "$(free_port)" --arg run_dir "$2" --arg volume "$1" --arg keys "$keys_dir" \
    --arg lease "$lease_dir" --arg image "$image_dir" --arg origin "$ORIGIN" --arg operator "$OPERATOR_ADDRESS" '{
    version: "bwg-self-host/0.1",
    network: "regtest",
    public: { origin: $origin, frontPort: ($front_port | tonumber) },
    private: { proxyAddress: "127.0.0.1", proxyPort: ($proxy_port | tonumber), runDirectory: $run_dir, postgresVolume: $volume },
    node: { kind: "managed" },
    trust: { ownerTrust: "\($lease)/trust.json", imageDirectory: $image },
    secrets: { keysDirectory: $keys, leaseAuthorityDirectory: $lease },
    poolOffers: { engine: "hydra", payout: "claimant_selected", operatorAddress: $operator },
    actionPolicies: ["account-creation.standard.v1"],
    payoutTerms: {},
    standardWorker: { displayName: "Your Stratum V1 Worker", hashrateHs: "1000000" }
  }' | jq "${3:-.}"
}

config="$proof_root/self-host.json"
write_config "$volume" "$proof_root/run" >"$config"

expect_config_refusal() {
  expected_message=$1
  filter=$2
  write_config "$volume" "$proof_root/run" "$filter" >"$proof_root/refused.json"
  refusal_exit=0
  "$repo_root/scripts/self-host-gate.sh" --config "$proof_root/refused.json" >"$proof_root/refusal.log" 2>&1 ||
    refusal_exit=$?
  if ((refusal_exit != 2)) || ! grep -Fq -- "$expected_message" "$proof_root/refusal.log"; then
    cat "$proof_root/refusal.log" >&2
    fail "expected exit 2 with \"$expected_message\", got exit $refusal_exit"
  fi
  printf 'Configuration refused: %s\n' "$expected_message"
}
expect_config_refusal 'node.kind managed is for regtest only' '.network = "mainnet"'
expect_config_refusal 'secrets.seed is not a known field' '.secrets.seed = "00"'
expect_config_refusal 'secrets.keysDirectory must be outside the repository' ".secrets.keysDirectory = \"$repo_root/keys\""
expect_config_refusal 'public.origin must be https://HOST or tailscale' '.public.origin = "http://gate.selfhost.test"'

# Built before anything serves dist/; the launcher builds the services the same way, in debug.
(cd "$repo_root" && cargo build --all-features --example stratum-cpu-miner >"$proof_root/build.log" 2>&1) ||
  fail "the CPU miner did not build"

# A launch whose pool never answers refuses at its readiness deadline and leaves nothing running.
refused_plan=$(write_config "$refused_volume" "$proof_root/run-refused" >"$proof_root/refused.json" &&
  bun "$repo_root/scripts/self-host-config.ts" --config "$proof_root/refused.json")
refused_args=()
while IFS= read -r -d '' argument; do
  refused_args+=("$argument")
done < <(jq -j '.launcherArguments[] | "\(.)\u0000"' <<<"$refused_plan")
# The launcher refuses an upstream nobody listens on, so this pool accepts and never answers.
python3 -c '
import socket
listener = socket.socket()
listener.bind(("127.0.0.1", 0))
listener.listen()
print(listener.getsockname()[1], flush=True)
held = []
while True:
    held.append(listener.accept()[0])
' >"$proof_root/silent-pool.out" &
silent_pool_pid=$!
for _attempt in $(seq 1 100); do
  [[ "$(head -1 "$proof_root/silent-pool.out" 2>/dev/null)" =~ ^[0-9]+$ ]] && break
  sleep 0.1
done
silent_pool_port=$(head -1 "$proof_root/silent-pool.out")
[[ "$silent_pool_port" =~ ^[0-9]+$ ]] || fail "the silent pool never listened"
readiness_exit=0
"$repo_root/scripts/launch-gate-deployment.sh" "${refused_args[@]}" --upstream "127.0.0.1:$silent_pool_port" \
  --readiness-timeout "$READINESS_FAILURE_TIMEOUT" >"$proof_root/launcher-unready.log" 2>&1 || readiness_exit=$?
kill -TERM "$silent_pool_pid"
silent_pool_exit=0
wait "$silent_pool_pid" || silent_pool_exit=$?
# 143 is the TERM this script sent.
((silent_pool_exit == 143)) || fail "the silent pool exited $silent_pool_exit before it was stopped"
silent_pool_pid=""
((readiness_exit == 2)) && grep -Fq 'the deployment never became ready' "$proof_root/launcher-unready.log" ||
  fail "a launch with no pool exited $readiness_exit without refusing as unready"
if docker ps --format '{{.Names}}' | grep -q '^bwg-gate-deployment-'; then
  fail "a launch refused as unready left PostgreSQL running"
fi
printf 'A launch whose pool never answers refused at its %ss readiness deadline\n' "$READINESS_FAILURE_TIMEOUT"
docker volume rm "$refused_volume" >/dev/null

# Starts the deployment through the supported path of checkout $3 (this one by default) and waits
# for the launcher's ready line.
start_self_host() {
  "${3:-$repo_root}/scripts/self-host-gate.sh" --config "$1" >"$2" 2>&1 &
  self_host_pid=$!
  for _attempt in $(seq 1 3000); do
    grep -q '^gate_deployment=ready' "$2" 2>/dev/null && break
    kill -0 "$self_host_pid" 2>/dev/null || fail "the self-hosted deployment exited before it was ready"
    sleep 0.2
  done
  ready_line=$(grep '^gate_deployment=ready' "$2") || fail "the self-hosted deployment never became ready"
  postgres_container=$(sed -n 's/.*postgres_container=\([^ ]*\).*/\1/p' <<<"$ready_line")
}

stop_self_host() {
  kill -TERM "$self_host_pid"
  self_host_exit=0
  wait "$self_host_pid" || self_host_exit=$?
  self_host_pid=""
  ((self_host_exit == 0)) || fail "the self-hosted deployment stopped with exit $self_host_exit"
}

front="http://127.0.0.1:$front_port"

postgres_query() {
  docker exec "$postgres_container" psql -h 127.0.0.1 -U bwg -d "$1" -tAc "$2"
}

# A challenge created through the front with the deployment's service credential.
create_challenge() {
  challenge_status=$(curl --silent --output /dev/null --write-out '%{http_code}' \
    --header 'content-type: application/json' --header "origin: $ORIGIN" \
    --data "$(jq -cn --arg key "$CLAIMANT_KEY" '{claimant_key: $key}')" "$front/account-creation/challenge")
  [[ "$challenge_status" == "201" ]] || fail "challenge creation returned $challenge_status"
}

provenance_commit() {
  curl --fail --silent "$front/provenance" | jq -er '.source.commit'
}

# Upgrade source: UPGRADE_FROM in a clean worktree. Its Rust builds are cached under this
# repository's ignored target directory, and it reuses this checkout's pinned Hydra build.
git -C "$repo_root" worktree add --quiet --detach "$upgrade_source" "$UPGRADE_FROM"
upgrade_worktree_added=true
mkdir -p "$upgrade_source/target" "$repo_root/target/self-host-upgrade-debug"
ln -s "$repo_root/target/self-host-upgrade-debug" "$upgrade_source/target/debug"
for hydra_build in "$repo_root"/target/hydra-v*; do
  if [[ -d "$hydra_build" ]]; then
    ln -s "$hydra_build" "$upgrade_source/target/$(basename "$hydra_build")"
  fi
done
(cd "$upgrade_source" && bun install --frozen-lockfile) >"$proof_root/upgrade-install.log" 2>&1 ||
  fail "the upgrade source's dependencies did not install"
start_self_host "$config" "$proof_root/self-host-upgrade-from.log" "$upgrade_source"
[[ "$(provenance_commit)" == "$UPGRADE_FROM" ]] || fail "the upgrade source does not report $UPGRADE_FROM"
create_challenge
stop_self_host
printf 'Launched %s, the upgrade source, and created a challenge on its volume\n' "${UPGRADE_FROM:0:12}"

start_self_host "$config" "$proof_root/self-host.log"
printf 'Self-hosted deployment ready through scripts/self-host-gate.sh\n'
# The services migrate as they start: every migration file is applied, and the old data is kept.
for database in gate_authority pool_adapter relying_service; do
  # Each service keeps its migrations table in its own schema, or in public.
  migrations_schema=$(postgres_query "$database" \
    "SELECT table_schema FROM information_schema.tables WHERE table_name = '_sqlx_migrations'")
  [[ "$migrations_schema" =~ ^[a-z_]+$ ]] || fail "$database has no single migrations table"
  applied=$(postgres_query "$database" "SELECT count(*) FROM $migrations_schema._sqlx_migrations WHERE success")
  files=$(find "$repo_root/migrations/$database" -name '*.sql' | wc -l | tr -d ' ')
  [[ "$applied" == "$files" ]] || fail "$database has $applied migrations applied, not $files"
done
upgraded_challenges=$(postgres_query gate_authority 'SELECT count(*) FROM gate_authority.work_challenges')
((upgraded_challenges == 1)) || fail "the upgrade kept $upgraded_challenges challenges, not 1"
printf 'Upgraded on the same volume: every migration applied and the challenge kept\n'

# Operational routes: health, readiness with an admitted job, and the build's provenance.
curl --fail --silent "$front/healthz" | jq -e '.status == "available"' >/dev/null || fail "/healthz is not available"
curl --fail --silent "$front/readyz" | jq -e '.ready == true and .miningJob == "admitted_job"' >/dev/null ||
  fail "/readyz does not report an admitted mining job"
expected_commit=$(git -C "$repo_root" rev-parse HEAD)
[[ -z "$(git -C "$repo_root" status --porcelain)" ]] || expected_commit="$expected_commit-dirty"
# Hydra's AGPL source offer: the pinned archive, and each patch at the commit this build came from.
curl --fail --silent "$front/provenance" | jq -e --arg commit "$expected_commit" --arg origin "$ORIGIN" '
  .source.commit == $commit and .discovery == "\($origin)/.well-known/pow-gate-configuration"
  and (.engine.patches[0] | test("regtest")) and .bitcoinCore.version == "31.1"
  and (.engine.source.upstream.url | startswith("https://github.com/p2poolv2/p2poolv2/"))
  and (.engine.source.patches | length) == (.engine.patches | length)
  and all(.engine.source.patches[]; .url | contains("/raw/\($commit | sub("-dirty$"; ""))/integration/hydra-solo/"))' \
  >/dev/null || fail "/provenance does not name this build, its pins and Hydra's source"
curl --fail --silent "$front/.well-known/pow-gate-configuration" | jq -e --arg commit "$expected_commit" \
  '.source.commit == $commit' >/dev/null || fail "discovery does not name this build's commit"
printf 'Health, readiness and provenance answer; discovery names commit %s\n' "${expected_commit:0:12}"

# A throwaway TLS proxy for the origin, as the self-hoster's own proxy would be.
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=$ORIGIN_HOST" \
  -keyout "$integration_root/proxy-key.pem" -out "$integration_root/proxy-cert.pem" >/dev/null 2>&1
cat >"$integration_root/tls-proxy.ts" <<'PROXY'
const target = process.env.BWG_PROXY_TARGET!;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  tls: { cert: Bun.file(process.env.BWG_PROXY_CERT!), key: Bun.file(process.env.BWG_PROXY_KEY!) },
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
    return await fetch(`${target}${url.pathname}${url.search}`, { method: request.method, headers: request.headers, body, redirect: "manual" });
  },
});
console.log(server.port);
PROXY
BWG_PROXY_TARGET="$front" BWG_PROXY_CERT="$integration_root/proxy-cert.pem" BWG_PROXY_KEY="$integration_root/proxy-key.pem" \
  bun "$integration_root/tls-proxy.ts" >"$proof_root/tls-proxy.log" 2>&1 &
proxy_pid=$!
for _attempt in $(seq 1 100); do
  [[ "$(head -1 "$proof_root/tls-proxy.log" 2>/dev/null)" =~ ^[0-9]+$ ]] && break
  sleep 0.1
done
proxy_port=$(head -1 "$proof_root/tls-proxy.log")
[[ "$proxy_port" =~ ^[0-9]+$ ]] || fail "the TLS proxy never listened"

BWG_MINER_CONTROL_ADDRESS=127.0.0.1:0 "$repo_root/target/debug/examples/stratum-cpu-miner" \
  >"$proof_root/miner.out" 2>"$proof_root/miner.log" &
miner_pid=$!
for _attempt in $(seq 1 100); do
  [[ "$(head -1 "$proof_root/miner.out" 2>/dev/null)" =~ ^[0-9]+$ ]] && break
  sleep 0.1
done
miner_port=$(head -1 "$proof_root/miner.out")
[[ "$miner_port" =~ ^[0-9]+$ ]] || fail "the CPU miner's control never listened"

chrome_binary=${BWG_TEST_CHROME:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
chrome_profile="$integration_root/chrome-profile"
"$chrome_binary" --headless=new --remote-debugging-port=0 --user-data-dir="$chrome_profile" \
  --no-first-run --no-default-browser-check --ignore-certificate-errors \
  --host-resolver-rules="MAP $ORIGIN_HOST 127.0.0.1:$proxy_port" about:blank >"$integration_root/chrome.log" 2>&1 &
chrome_pid=$!
for _attempt in $(seq 1 300); do
  [[ -s "$chrome_profile/DevToolsActivePort" ]] && break
  sleep 0.1
done
[[ -s "$chrome_profile/DevToolsActivePort" ]] || fail "Chrome did not open its DevTools port"
devtools="ws://127.0.0.1:$(sed -n 1p "$chrome_profile/DevToolsActivePort")$(sed -n 2p "$chrome_profile/DevToolsActivePort")"

bun "$repo_root/scripts/self-host-journey.ts" --browser "$devtools" --origin "$ORIGIN" \
  --payout-address "$OPERATOR_ADDRESS" --miner-control "http://127.0.0.1:$miner_port" >"$proof_root/journey.log" 2>&1 ||
  fail "the claimant's journey through the self-hosted page did not pass"
cat "$proof_root/journey.log"
journey_challenges=$(docker exec "$postgres_container" psql -h 127.0.0.1 -U bwg -d gate_authority -tAc \
  "SELECT count(*) FROM gate_authority.work_challenges")
((journey_challenges > upgraded_challenges)) || fail "the Authority holds no challenge from the journey"

# Backup while running, then a restore into a new volume and a relaunch on it.
"$repo_root/scripts/self-host-operations.sh" backup --volume "$volume" --output "$proof_root/backup"
(((8#$(stat -f '%Lp' "$proof_root/backup") & 8#077) == 0)) || fail "the backup directory is readable by others"
stop_self_host
if docker ps -a --format '{{.Names}}' | grep -q '^bwg-gate-deployment-'; then
  fail "the deployment left PostgreSQL behind"
fi
"$repo_root/scripts/self-host-operations.sh" restore --volume "$restored_volume" --keys-dir "$keys_dir" \
  --input "$proof_root/backup"
restore_refusal=0
"$repo_root/scripts/self-host-operations.sh" restore --volume "$restored_volume" --keys-dir "$keys_dir" \
  --input "$proof_root/backup" >"$proof_root/restore-refusal.log" 2>&1 || restore_refusal=$?
((restore_refusal == 2)) && grep -Fq "volume $restored_volume already exists" "$proof_root/restore-refusal.log" ||
  fail "a restore over an existing volume was not refused"
printf 'Backup taken while running; restore refuses to overwrite a volume\n'

restored_config="$proof_root/self-host-restored.json"
write_config "$restored_volume" "$proof_root/run-restored" >"$restored_config"
start_self_host "$restored_config" "$proof_root/self-host-restored.log"
restored_challenges=$(docker exec "$postgres_container" psql -h 127.0.0.1 -U bwg -d gate_authority -tAc \
  "SELECT count(*) FROM gate_authority.work_challenges")
[[ "$restored_challenges" == "$journey_challenges" ]] ||
  fail "the restored deployment holds $restored_challenges challenges, not $journey_challenges"
curl --fail --silent "$front/readyz" | jq -e '.ready == true' >/dev/null || fail "the restored deployment is not ready"
stop_self_host
printf 'Relaunched on the restored volume with its %s challenge(s)\n' "$restored_challenges"

# Gate Pass key rotation: new keys, the old public key published beside the new one, and the
# volume's password carried over; then the old key dropped once its passes have expired.
rotated_keys="$proof_root/keys-rotated"
bun "$repo_root/scripts/gate-deployment-keys.ts" --directory "$rotated_keys" >/dev/null
old_kid=$(jq -er .kid "$keys_dir/gate-pass-signing.json")
new_kid=$(jq -er .kid "$rotated_keys/gate-pass-signing.json")
(
  umask 077
  cp "$keys_dir/postgres-credential.json" "$rotated_keys/"
  jq -s '.[0] + .[1]' "$rotated_keys/gate-pass-public-keys.json" "$keys_dir/gate-pass-public-keys.json" \
    >"$rotated_keys/gate-pass-public-keys.next"
)
mv "$rotated_keys/gate-pass-public-keys.next" "$rotated_keys/gate-pass-public-keys.json"
old_lease_kid=$(jq -er .activeKid "$lease_dir/lease-private.json")
bun "$repo_root/scripts/worker-development-authority.ts" rotate --directory "$lease_dir" --role lease >/dev/null
new_lease_kid=$(jq -er .activeKid "$lease_dir/lease-private.json")
[[ "$new_lease_kid" != "$old_lease_kid" ]] || fail "the Work Lease key did not rotate"

published_kids() {
  curl --fail --silent "$front/.well-known/jwks.json" | jq -c '[.keys[].kid] | sort'
}
page_trusted_kids() {
  curl --fail --silent "$front/reference/account-creation.html" |
    sed -n 's/.*<script type="application\/json" id="bwg-reference-config">\(.*\)<\/script>.*/\1/p' |
    jq -c '[.authorityTrust.trustedKeys[].kid] | sort'
}
rotated_config="$proof_root/self-host-rotated.json"
write_config "$restored_volume" "$proof_root/run-rotated" ".secrets.keysDirectory = \"$rotated_keys\"" >"$rotated_config"
start_self_host "$rotated_config" "$proof_root/self-host-rotated.log"
both_kids=$(jq -cn --arg a "$old_kid" --arg b "$new_kid" '[$a, $b] | sort')
[[ "$(published_kids)" == "$both_kids" ]] || fail "the Authority doesn't publish both Gate Pass keys"
[[ "$(page_trusted_kids)" == "$both_kids" ]] || fail "the page doesn't trust both Gate Pass keys"
create_challenge
seeded_lease=$(postgres_query gate_authority \
  "SELECT last_sequence FROM gate_authority.work_lease_authorization_sequences WHERE key_id = '$new_lease_kid'")
[[ "$seeded_lease" =~ ^[0-9]+$ ]] || fail "the rotated Work Lease key has no sequence"
stop_self_host
recorded_lease=$(jq -er --arg kid "$new_lease_kid" '.sequences[$kid]' "$lease_dir/lease-sequence.json")
[[ "$recorded_lease" == "$seeded_lease" ]] || fail "the rotated lease key's high-water mark recorded as $recorded_lease"
jq -e --arg kid "$old_lease_kid" '.sequences[$kid] | test("^[0-9]+$")' "$lease_dir/lease-sequence.json" >/dev/null ||
  fail "the old lease key's high-water mark was lost"
printf 'Rotated: both Gate Pass keys published and trusted, a challenge created with the new credential, the new Work Lease key seeded and recorded\n'

(
  umask 077
  jq --arg kid "$old_kid" 'map(select(.kid != $kid))' "$rotated_keys/gate-pass-public-keys.json" \
    >"$rotated_keys/gate-pass-public-keys.next"
)
mv "$rotated_keys/gate-pass-public-keys.next" "$rotated_keys/gate-pass-public-keys.json"
start_self_host "$rotated_config" "$proof_root/self-host-retired.log"
[[ "$(published_kids)" == "$(jq -cn --arg kid "$new_kid" '[$kid]')" ]] || fail "the old Gate Pass key is still published"
stop_self_host
printf 'Retired the old Gate Pass key\n'

secrets=(
  "$(jq -r .seed "$keys_dir/gate-pass-signing.json")"
  "$(jq -r .credential "$keys_dir/service-credential.json")"
  "$(jq -r .key "$keys_dir/stratum-credential-key.json")"
  "$(jq -r .password "$keys_dir/postgres-credential.json")"
  "$(jq -r .seed "$rotated_keys/gate-pass-signing.json")"
  "$(jq -r .credential "$rotated_keys/service-credential.json")"
  "$(jq -r .key "$rotated_keys/stratum-credential-key.json")"
)
while IFS= read -r lease_seed; do
  secrets+=("$lease_seed")
done < <(jq -r '.keys[].d' "$lease_dir/lease-private.json")
for log_path in "$proof_root"/*.log "$proof_root"/run*/*.log; do
  for secret in "${secrets[@]}"; do
    if grep -Fq -- "$secret" "$log_path"; then
      fail "$(basename "$log_path") holds a private value"
    fi
  done
done
printf 'No private value in the logs\n'
printf 'Self-host proof passed\n'
