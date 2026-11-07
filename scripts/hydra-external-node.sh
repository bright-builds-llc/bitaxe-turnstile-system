#!/usr/bin/env bash
# A Bitcoin Core node this stack neither downloads nor starts, reached on loopback
# (for Ticket 07, through the owner's SSH tunnel). Its RPC credentials come from a
# file outside the repository. They reach curl on stdin and Hydra through its
# environment, never a command line, a rendered file or a log. Callers set
# repo_root before sourcing this file.

# Prints PORT when URL is exactly SCHEME://127.0.0.1:PORT.
loopback_port() {
  scheme=$1
  url=$2
  if ! [[ "$url" =~ ^${scheme}://127\.0\.0\.1:([0-9]{1,5})/?$ ]]; then
    return 1
  fi
  port=$((10#${BASH_REMATCH[1]}))
  if ((port < 1 || port > 65535)); then
    return 1
  fi
  printf '%s\n' "$port"
}

# Reads rpcuser and rpcpassword (bitcoin.conf syntax) into rpc_user and
# rpc_password. Refusals name the problem, never a line of the file.
load_rpc_credentials() {
  credentials_path=$1
  if [[ "$credentials_path" != /* ]] || [[ ! -f "$credentials_path" ]]; then
    printf 'The RPC credentials file must be an existing absolute path\n' >&2
    return 2
  fi
  credentials_dir=$(cd "$(dirname "$credentials_path")" && pwd -P)
  if [[ "$credentials_dir/" == "$(cd "$repo_root" && pwd -P)/"* ]]; then
    printf 'The RPC credentials file must be outside the repository\n' >&2
    return 2
  fi
  if (((8#$(stat -f '%Lp' "$credentials_path") & 8#077) != 0)); then
    printf 'The RPC credentials file must be readable only by its owner (chmod 600)\n' >&2
    return 2
  fi
  rpc_user=""
  rpc_password=""
  while IFS= read -r line || [[ -n "$line" ]]; do
    line=${line%$'\r'}
    case "$line" in
      "" | "#"*) ;;
      rpcuser=*) rpc_user=${line#rpcuser=} ;;
      rpcpassword=*) rpc_password=${line#rpcpassword=} ;;
      *)
        printf 'The RPC credentials file may hold only rpcuser= and rpcpassword= lines\n' >&2
        return 2
        ;;
    esac
  done <"$credentials_path"
  if [[ -z "$rpc_user" || -z "$rpc_password" ]]; then
    printf 'The RPC credentials file must set both rpcuser and rpcpassword\n' >&2
    return 2
  fi
}

curl_config_quote() {
  quoted=${1//\\/\\\\}
  printf '%s' "${quoted//\"/\\\"}"
}

# Calls METHOD with no parameters and prints its result.
external_rpc() {
  method=$1
  if ! response=$(printf 'user = "%s"\n' "$(curl_config_quote "$rpc_user:$rpc_password")" |
    curl --config - --silent --show-error --fail --max-time 10 \
      --header 'content-type: text/plain' \
      --data-binary "{\"jsonrpc\":\"1.0\",\"id\":\"bwg\",\"method\":\"$method\",\"params\":[]}" \
      "http://127.0.0.1:$rpc_port/"); then
    printf 'Bitcoin Core RPC on 127.0.0.1:%s refused or did not answer %s; check the tunnel and the credentials file\n' \
      "$rpc_port" "$method" >&2
    return 1
  fi
  jq -c .result <<<"$response"
}

# Prints the node's version, chain and sync state; succeeds only when it reports
# EXPECTED_CHAIN and has left initial block download.
require_external_node() {
  expected_chain=$1
  chain_info=$(external_rpc getblockchaininfo)
  network_info=$(external_rpc getnetworkinfo)
  node_chain=$(jq -r .chain <<<"$chain_info")
  node_ibd=$(jq -r .initialblockdownload <<<"$chain_info")
  printf 'External Bitcoin Core %s: chain %s, %s blocks of %s headers, initial block download %s\n' \
    "$(jq -r .subversion <<<"$network_info")" "$node_chain" \
    "$(jq -r .blocks <<<"$chain_info")" "$(jq -r .headers <<<"$chain_info")" "$node_ibd"
  if [[ "$node_chain" != "$expected_chain" ]]; then
    printf 'Refusing to start Hydra: the node reports chain %s, not %s\n' "$node_chain" "$expected_chain" >&2
    return 1
  fi
  if [[ "$node_ibd" != "false" ]]; then
    printf 'Refusing to start Hydra: the node is still in initial block download\n' >&2
    return 1
  fi
}
