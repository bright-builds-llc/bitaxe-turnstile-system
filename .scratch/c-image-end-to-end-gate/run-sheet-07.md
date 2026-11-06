# Run sheet: first Gate on the C image (Ticket 07)

Ticket 06 rehearses this run on regtest, with test keys, a fake serial Worker and
a CPU miner: `scripts/rehearse-production-path.sh` (macOS arm64, about two
minutes after the first build). Ticket 07 replaces those parts
and changes nothing else. Nothing private goes into either repository.

## What runs

- **Page.** `reference/account-creation.html`, built by `bun run build:browser`.
  The deployment fills its `bwg-reference-config` JSON with public trust only: the
  Authority's issuer and public keys, the board's USB filter, the trusted update
  keys, and the expected firmware commit and app ELF digest.
- **One HTTPS origin.** It serves the page, routes `/v0` and `/.well-known` to
  `gate-authority`, and routes `/account-creation` to `reference-service`.
- **`gate-authority`.** It runs the Pool Adapter's proxy, delivery and expiry
  sweep in its own process (ADR-0109), switched on by
  `BWG_STRATUM_PROXY_LISTEN_ADDRESS`. It also needs `BWG_POOL_ADAPTER_DATABASE_URL`,
  `BWG_POOL_UPSTREAM_STRATUM_ADDRESS` and `BWG_POOL_UPSTREAM_PASSWORD`. Claimant
  leases need the `BWG_WORK_LEASE_AUTHORITY_*` and `BWG_STRATUM_CREDENTIAL_KEY`
  variables, and `BWG_WORKER_STRATUM_ENDPOINT` names the proxy as the board
  reaches it.
- **`reference-service`**, with the account-creation executor.
- **PostgreSQL**, one database each for the Authority, the Reference Relying
  Service and the Pool Adapter.
- **Hydra and Bitcoin Core**, at the pins in `scripts/hydra-regtest-stack.sh`.

## Record before starting

- The Gate commit (`git rev-parse HEAD`) and a clean worktree.
- The C image's commit and app ELF SHA-256, from the firmware repository.
- The Hydra and Bitcoin Core pins.
- The page bundle's build, from the same commit.

## Steps only the owner runs

1. Choose the network. Criterion 5 needs mainnet with per-job BIP 23 admission
   (Core Ticket 18).
2. Flash the 601 by hand with the C reference image, and record its digests.
3. Load the private values from `~/.bitaxe-fork-private` into the deployment's
   environment, never into a file in either repository:
   - the Gate Pass signing seed (`BWG_AUTHORITY_SIGNING_SEED`);
   - the Work Lease Authority seed (`BWG_WORK_LEASE_AUTHORITY_SEED`);
   - the Stratum credential key (`BWG_STRATUM_CREDENTIAL_KEY`);
   - the service credential (`BWG_SERVICE_CREDENTIAL`);
   - the database URLs;
   - the pool address and password.
   Agents never see these values. The payout address is typed into the page.
4. Serve the origin with a real certificate, not the rehearsal's throwaway one.
5. At the board, click "Connect Bitaxe over USB", choose the board, consent and
   Start.

## What Ticket 07 changes from the rehearsal

| Rehearsal (Ticket 06) | Ticket 07 |
| --- | --- |
| Fake serial Worker with fixture identity | The 601 over Web Serial |
| CPU miner on the Worker's Stratum grant | The board's ASIC on the same grant |
| Test Work Lease, Gate Pass and service keys | The owner's keys, loaded by the owner |
| Regtest | The owner's network choice |
| Loopback front with a self-signed certificate | The real same-origin HTTPS front |
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
