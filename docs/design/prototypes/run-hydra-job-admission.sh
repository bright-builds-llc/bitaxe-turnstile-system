#!/usr/bin/env bash
set -euo pipefail

prototype_root=$(mktemp -d)
upstream_dir="$prototype_root/p2poolv2"
prototype_patch="$(cd "$(dirname "$0")" && pwd)/p2poolv2-v0.12.0-job-admission.patch"

git clone --filter=blob:none https://github.com/p2poolv2/p2poolv2.git "$upstream_dir"
git -C "$upstream_dir" checkout 8eca024bde6c2de74620dce2f9cc7fb9a544c5c0
git -C "$upstream_dir" apply "$prototype_patch"

cargo test --manifest-path "$upstream_dir/Cargo.toml" -p p2poolv2_lib prototype_
cargo test --manifest-path "$upstream_dir/Cargo.toml" -p p2poolv2_lib test_validate_bitcoin_block
cargo test --manifest-path "$upstream_dir/Cargo.toml" -p p2poolv2_lib \
  test_build_notify_and_extract_outputs_integration

printf 'Prototype checkout retained at %s\n' "$upstream_dir"
