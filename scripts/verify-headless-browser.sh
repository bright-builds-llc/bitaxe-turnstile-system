#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
playwright_cli="$repository_root/node_modules/.bin/playwright-cli"
session_name="bwg-headless-$$"
server_log="$(mktemp)"
browser_output="$(mktemp)"

cleanup() {
  exit_status=$?
  trap - EXIT
  set +e
  "$playwright_cli" -s="$session_name" close >/dev/null 2>&1
  if [[ -n "${server_pid:-}" ]]; then
    kill "$server_pid" >/dev/null 2>&1
    wait "$server_pid" >/dev/null 2>&1
  fi
  if ((exit_status != 0)); then
    echo "headless browser verification failed" >&2
    if [[ -s "$server_log" ]]; then
      echo "server log:" >&2
      cat "$server_log" >&2
    fi
    if [[ -s "$browser_output" ]]; then
      echo "browser output:" >&2
      cat "$browser_output" >&2
    fi
  fi
  rm -f "$server_log" "$browser_output"
  exit "$exit_status"
}
trap cleanup EXIT

cd "$repository_root"
bun scripts/serve-headless-browser.ts >"$server_log" 2>&1 &
server_pid=$!

for _ in {1..50}; do
  server_port="$(head -n 1 "$server_log")"
  if [[ ! "$server_port" =~ ^[0-9]+$ ]]; then
    sleep 0.1
    continue
  fi
  if curl --fail --silent --output /dev/null "http://127.0.0.1:$server_port/"; then
    break
  fi
  sleep 0.1
done
curl --fail --silent --output /dev/null "http://127.0.0.1:$server_port/"

"$playwright_cli" -s="$session_name" open \
  "http://127.0.0.1:$server_port/conformance/bwg-0.1/headless-work-consent-browser.html" \
  >"$browser_output"
"$playwright_cli" -s="$session_name" snapshot >>"$browser_output"

if ! grep -q 'status.*passed' "$browser_output"; then
  exit 1
fi

: >"$browser_output"
"$playwright_cli" -s="$session_name" goto \
  "http://127.0.0.1:$server_port/conformance/bwg-0.1/work-gate-component-browser.html" \
  >"$browser_output"
"$playwright_cli" -s="$session_name" snapshot >>"$browser_output"

if ! grep -q 'status.*passed' "$browser_output"; then
  exit 1
fi
