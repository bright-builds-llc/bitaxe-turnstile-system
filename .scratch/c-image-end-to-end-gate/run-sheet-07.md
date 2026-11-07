# Run sheet: first Gate on the C image (Ticket 07)

Ticket 06 rehearses this run on regtest, with test keys, a fake serial Worker and
a CPU miner: `scripts/rehearse-production-path.sh` (macOS arm64, about two
minutes after the first build). Ticket 07 replaces those parts
and changes nothing else. Nothing private goes into either repository.

## What runs

`scripts/launch-gate-deployment.sh` starts everything but Hydra and the tunnel.

- **Page.** `reference/account-creation.html`, built by `bun run build:browser`.
  `scripts/gate-deployment-page-config.ts` fills its `bwg-reference-config` JSON
  with public trust only: the Authority's issuer and public keys, the board's USB
  filter, the owner trust's Update Authority keys, and the C image's commit and
  app ELF digest.
- **One HTTPS origin**, this Mac's tailnet name through `tailscale serve`, with a
  Let's Encrypt certificate and reachable only from the tailnet. Behind it,
  `scripts/serve-gate-origin.ts` serves the page and its bundle and nothing else,
  routes `/v0` and `/.well-known` to `gate-authority`, and routes
  `/account-creation` to `reference-service`. Every https URL the binaries take
  derives from that origin.
- **`gate-authority`.** It runs the Pool Adapter's proxy, delivery and expiry
  sweep in its own process (ADR-0109), switched on by
  `BWG_STRATUM_PROXY_LISTEN_ADDRESS`. It also needs `BWG_POOL_ADAPTER_DATABASE_URL`,
  `BWG_POOL_UPSTREAM_STRATUM_ADDRESS` and `BWG_POOL_UPSTREAM_PASSWORD`. Claimant
  leases need the `BWG_WORK_LEASE_AUTHORITY_*` and `BWG_STRATUM_CREDENTIAL_KEY`
  variables, and `BWG_WORKER_STRATUM_ENDPOINT` names the proxy as the board
  reaches it. The proxy binds this Mac's LAN address, found at run time, because
  the board reaches it over Wi-Fi.
- **`reference-service`**, with the account-creation executor.
- **PostgreSQL** in Docker, one database each for the Authority, the Reference
  Relying Service and the Pool Adapter, kept for the run and dropped at the end.
- **Hydra on mainnet**, at the regtest runner's pin, started by
  `scripts/hydra-mainnet-stack.sh --external-node`. It uses the owner's existing
  synced mainnet node through an SSH tunnel. Hydra starts only if the node reports
  chain `main` and has left initial block download. It serves Stratum on loopback
  for `BWG_POOL_UPSTREAM_STRATUM_ADDRESS`.

## Node: the owner's existing node

The owner runs a synced mainnet node on a remote host. It runs official Bitcoin
Core 31.1, full, with `txindex=1`, which Hydra doesn't need but doesn't mind. Its
RPC and ZMQ listen only on that host, so the stack reaches them through a tunnel.

**Deviation that Ticket 07's evidence must name.** The node runs Bitcoin Core
31.1, but the Gate pins 28.1. Hydra calls only `getblockchaininfo`,
`getblocktemplate` (including the BIP 23 proposal), `getdifficulty`,
`submitblock` and `decoderawtransaction`, so this is not expected to matter.
Only the regtest runs at 28.1 show it. The stack prints the node's version, and
the evidence records it.

1. Write the RPC credentials file once, outside the repository, for example
   under `~/.bitaxe-fork-private`. It holds only the node's `rpcuser=` and
   `rpcpassword=` lines, copied from its `bitcoin.conf`. Make it owner-only with
   `chmod 600`, or the stack refuses it.
2. Open the tunnel in its own terminal and leave it open:

   ```bash
   ssh -N -o RemoteCommand=none -L 18332:127.0.0.1:8332 -L 28332:127.0.0.1:28332 YOUR_NODE_ALIAS
   ```

   This expects the node's RPC and `zmqpubhashblock` to listen on the host's
   loopback, or on all addresses.
3. Create the datadir first, because the stack refuses a missing one. Then start Hydra:

   ```bash
   mkdir -m 700 /path/outside/the/repo
   ```

   ```bash
   scripts/hydra-mainnet-stack.sh --external-node --datadir /path/outside/the/repo \
     --rpc-url http://127.0.0.1:18332 --zmq-url tcp://127.0.0.1:28332 \
     --rpc-credentials-file ~/.bitaxe-fork-private/RPC_CREDENTIALS_FILE \
     --payout-from-pool-user ~/Repos/bitaxe-esp-miner/pool-credentials.json
   ```

   `--payout-from-pool-user` takes the pool user up to its first dot as Hydra's
   payout address, and never prints it.

The stack never downloads or starts Bitcoin Core in this mode, and never tells
the node to stop. It accepts only `127.0.0.1` URLs, so RPC's basic auth never
leaves this machine except inside the tunnel. The credentials reach curl on stdin
and Hydra through its environment. They never go on a command line, into the
rendered config or into a log. They are visible only to this user's processes,
as the file already is. `scripts/verify-hydra-solo-integration.sh --external-node`
proves the mode on regtest. It treats a separately started node as the owner's
node: the stack refuses it on chain `regtest`, wrong credentials, a
non-loopback URL and a loose file mode, and leaves it running. Hydra then passes
the integration through the same path.

## Fallback: a pruned node on this machine

If the existing node is unavailable, the same script runs its own node.
Neither Hydra nor job admission (Reward Policy and the BIP 23 proposal) reads the
transaction index, and both pass against a pruned node with early blocks
deleted. So that node is pruned, without `-txindex`.

| Node | Disk, late 2026 | Fits the 25 GiB free here |
| --- | --- | --- |
| Pruned at `-prune=550`, no txindex (this stack) | about 12 GB, mostly the UTXO set | yes; keep a few GB spare, as the UTXO set grows |
| Full, no txindex | about 770 GB | no |
| Full with txindex | over 800 GB | no |

Pruning saves disk, not sync time. The node still downloads and checks about
770 GB. Expect roughly a day on this machine with a large cache and a fast link,
and several days on a slow link. Start it well before the run:

```bash
scripts/hydra-mainnet-stack.sh --datadir /path/outside/the/repo --prune 550 \
  --payout-address ADDRESS --wait-for-sync -- -dbcache=8000
```

The datadir holds `bitcoin/` and `hydra/`, and a later start resumes the sync.
This path runs Bitcoin Core 28.1, the pin, so it has no version deviation.
Without `--wait-for-sync`, the script refuses to start Hydra while the node is
syncing.

## Record before starting

- The Gate commit (`git rev-parse HEAD`) and a clean worktree.
- The C image's commit and app ELF SHA-256, from the firmware repository.
- The Hydra and Bitcoin Core pins, and the node's version as the stack prints it
  (31.1 on the existing node, a deviation).
- The page bundle's build, from the same commit.

## Steps only the owner runs

Each step runs in the owner's own shell. Agents never see the files these
commands read.

1. Once: turn on HTTPS certificates for the tailnet, start Docker, and generate
   the Gate's own keys:

   ```bash
   bun scripts/gate-deployment-keys.ts --directory ~/.bitaxe-fork-private/t07
   ```

   It writes the Gate Pass signing seed, its public JWKS entry, the service
   credential and the Stratum credential key, each mode 600, and prints only the
   kid and the public key. It refuses to overwrite them.
2. Open the tunnel and start Hydra against the existing node (see above), each in
   its own terminal. The network is mainnet, with per-job BIP 23 admission (Core
   Ticket 18).
3. Flash the 601 by hand with the C reference image. Its `COMMIT` and
   `SHA256SUMS` go in `~/.bitaxe-fork-private/reference/image`.
4. Launch the Gate in a third terminal:

   ```bash
   scripts/launch-gate-deployment.sh --keys-dir ~/.bitaxe-fork-private/t07 \
     --lease-authority-dir ~/.local/share/bitaxe-worker-acceptance-20260904 \
     --owner-trust ~/.bitaxe-fork-private/owner-trust/trust.json \
     --image-dir ~/.bitaxe-fork-private/reference/image \
     --run-dir ~/.bitaxe-fork-private/t07/run
   ```

   It refuses to start unless every key file is owner-only and readable. It
   also refuses if the Work Lease Authority's active key isn't the one the
   owner trust names, or if Hydra isn't listening. It seeds the lease sequence
   1000 above `lease-sequence.json`, because the board refuses any sequence at or
   below one it has stored. It prints the Gate commit, the kids, the seeded
   sequence and the page URL. macOS may ask to allow incoming connections for
   the proxy's port; the board needs them.
5. Open the printed URL in Chrome on this Mac, with the board on USB. Type the
   claimant's payout address, click "Connect Bitaxe over USB", choose the board,
   consent and Start.
6. Press Ctrl-C when done. The launcher raises `lease-sequence.json` to the run's
   high-water mark, under that directory's lock, and then drops the databases. The
   run directory's logs show the LAN address and the tailnet name only as
   `LAN_ADDRESS` and `ORIGIN_HOST`.

`scripts/rehearse-gate-deployment-launch.sh` proves steps 1, 4 and 6 on regtest
with generated test keys. It checks the refusals, the seeded sequence, the filled
page config, that the front serves nothing beyond the page, the recorded
high-water mark, and logs free of private values. It doesn't use Tailscale, the
LAN, the board or the owner's files.

## What Ticket 07 changes from the rehearsal

| Rehearsal (Ticket 06) | Ticket 07 |
| --- | --- |
| Fake serial Worker with fixture identity | The 601 over Web Serial |
| CPU miner on the Worker's Stratum grant | The board's ASIC on the same grant |
| Test Work Lease, Gate Pass and service keys | The owner's keys, read by `scripts/launch-gate-deployment.sh` |
| Regtest Bitcoin Core 28.1, pruned, no txindex | The owner's mainnet Bitcoin Core 31.1 through a tunnel |
| Loopback front with a self-signed certificate | `tailscale serve` on the tailnet name |
| One synthetic share crosses the Work Requirement | Real accepted shares only |

## Pass

- Consent is shown, then Start.
- At least one Renew lands while shares are still being delivered.
- Adapter-accepted shares are credited as Verified Progress, and the Work
  Requirement is reached.
- Restoration is confirmed as `challenge_satisfied`, and mining stops.
- The Gate Pass is redeemed once with DPoP and refused on reuse.

## Stop at once

- The board mines without a lease, or keeps mining after restoration.
- Restoration is anything other than confirmed.
- Delivery refuses a share terminally, which should not happen on a healthy run.
- Verified Progress moves without adapter-accepted work.
- A private value shows up in a log, a page, a commit or a ticket.

On a stop, press Cancel, unplug the board if it keeps mining, and keep the logs
out of the repository.

## Non-claims

- The rehearsal does not show that real shares reach the Standard Work
  Requirement. One synthetic share crosses it, and only the rehearsal can send it
  (`tests/rehearsal_isolation.rs`). Ticket 07 proves the real threshold on the 601.
- The rehearsal says nothing about thermals, power or a board's own restoration.
- The launcher proof never issues a lease with the seeded sequence. The board's
  first accepted lease in Ticket 07 is the evidence that the sequence clears its
  replay guard.
- The operator policy, privacy and terms links on the consent screen don't
  resolve yet (Ticket 19).
