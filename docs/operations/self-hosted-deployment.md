# Running a self-hosted reference deployment

This is the runbook for a self-hosted BWG Core reference deployment (bwg-core Ticket 24). It runs the same services, page and launcher as the owner's deployment. The design is `docs/superpowers/specs/2026-11-26-self-hosted-reference-deployment-design.md`. The runbook covers macOS on arm64 only, like the pinned Hydra and Bitcoin Core runners.

## What you need

- This repository, at the commit you mean to run, with `bun`, `cargo`, `docker`, `jq`, `nc`, `curl` and `python3` installed.
- Your Gate keys: run `bun scripts/gate-deployment-keys.ts --directory DIR` once. It writes the Gate Pass signing key, its public JWKS, the Reference Relying Service's credential and the Stratum credential key, each readable only by you.
- A Work Lease Authority directory and an owner trust. `bun scripts/worker-development-authority.ts init --directory DIR` makes both. Its `trust.json` is the owner trust.
- A firmware image directory holding `COMMIT` and `SHA256SUMS`, for the boards your page will accept.
- On mainnet, a synced Bitcoin Core 31.1 node on loopback with ZMQ, and its RPC credentials in a file.
- An HTTPS reverse proxy for your public origin, or Tailscale.

Keep every one of these outside the repository. The configuration refuses a path inside it.

## Configuration

One JSON file, `bwg-self-host/0.1`. Unknown fields are refused, so a misspelling stops the launch. It names the paths of secrets, never their values.

```json
{
  "version": "bwg-self-host/0.1",
  "network": "mainnet",
  "public": { "origin": "https://gate.example.org", "frontPort": 8443 },
  "private": { "proxyAddress": "192.0.2.10", "proxyPort": 3334, "runDirectory": "/srv/bwg/run", "postgresVolume": "bwg-gate" },
  "node": {
    "kind": "external",
    "rpcUrl": "http://127.0.0.1:8332",
    "zmqUrl": "tcp://127.0.0.1:28332",
    "rpcCredentialsFile": "/srv/bwg/node-credentials",
    "datadir": "/srv/bwg/hydra"
  },
  "trust": { "ownerTrust": "/srv/bwg/lease/trust.json", "imageDirectory": "/srv/bwg/image" },
  "secrets": { "keysDirectory": "/srv/bwg/keys", "leaseAuthorityDirectory": "/srv/bwg/lease" },
  "poolOffers": { "engine": "hydra", "payout": "claimant_selected", "operatorAddress": "<your Hydra solo address>" },
  "actionPolicies": ["account-creation.standard.v1"],
  "payoutTerms": {},
  "standardWorker": { "displayName": "Your Stratum V1 Worker", "hashrateHs": "1000000000000" }
}
```

- **`public.origin`:** your HTTPS origin, with `frontPort` the loopback port your proxy forwards to. Or `"tailscale"`, which serves the tailnet name and takes no port.
- **`private`:**
  - `proxyAddress` and `proxyPort` are where Workers reach the Stratum proxy, normally a LAN address.
  - `runDirectory` holds logs and the page's config.
  - `postgresVolume` is the Docker volume that keeps the databases.
- **`node`:** on mainnet, `external`, which is your node. On regtest, `managed`: the stack starts its own.
- **`payoutTerms.expectedHashes`:** optional, a Work Requirement between 2^43 and 2^45. Without it the Standard policy's value applies.
- **`standardWorker`:** optional. With it, the page offers "Use another Stratum V1 Worker", and shows the lease's pool URL, username and password for any Stratum V1 miner (ADR-0114). Leave it out to offer Bitaxe boards only.

Check a file without launching:

```bash
bun scripts/self-host-config.ts --config /srv/bwg/self-host.json
```

## Launch

```bash
scripts/self-host-gate.sh --config /srv/bwg/self-host.json
```

It starts pinned Hydra (and, on regtest, Bitcoin Core). Then it runs `scripts/launch-gate-deployment.sh`, which starts:

- PostgreSQL on the volume;
- the Gate Authority, Pool Adapter and Reference Relying Service;
- the front that serves the page.

The services run their migrations as they start.

Startup stops with `Refusing …` and exit 2 when any of these happens:

- a pin, key or file is missing;
- a migration fails;
- the lease key isn't in the owner trust;
- Hydra isn't listening;
- the deployment isn't ready within `--readiness-timeout` (180 s).

It's ready when it prints `gate_deployment=ready`.

### What the front answers

| Path | Answers |
|---|---|
| `/healthz` | 200 when the Authority and the Relying Service answer; 503 naming the part that doesn't. |
| `/readyz` | 200 only when the application is healthy and Hydra handed the probe an admitted mining job. Otherwise 503, with `miningJob` set to `no_job`, `refused`, `unreachable` or `unconfigured`. The answer is cached for 30 s. |
| `/provenance` | The discovery URL; this build's source, version, commit and build time; the pinned engine, its licence and patches; and Bitcoin Core's version and licence. |
| `/.well-known/pow-gate-configuration` | Authority discovery, naming the same commit and build time. |

Point your monitoring at `/healthz` for liveness and `/readyz` for whether claimants can do work.

## Shutdown and recovery

Ctrl-C (or TERM) is the normal stop. The launcher records the Work Lease sequence's high-water mark in the lease directory and removes the PostgreSQL container. The volume stays.

To recover after a crash or a reboot, launch again with the same configuration. The lease sequence starts above every sequence a board has seen, and the volume's data is still there. A challenge that was in progress when the deployment stopped expires, and its claimant starts again. A Worker's lease credentials expire within 60 s, so no Worker keeps mining for a stopped deployment.

## Backup and restore

Back up while the deployment runs:

```bash
scripts/self-host-operations.sh backup --volume bwg-gate --output /srv/bwg/backups/2026-11-26
```

This writes one `pg_dump` file per database into a new directory that only you can read. The dumps hold challenges, Redemption Records and live payout choices, so keep them as private as the keys. The keys directory, which also holds the database password (`postgres-credential.json`), and the lease directory are not in the dump. Back them up separately, and encrypt them.

To restore, load the dump into a new volume, then launch with that volume:

```bash
scripts/self-host-operations.sh restore --volume bwg-gate-restored --keys-dir /srv/bwg/keys --input /srv/bwg/backups/2026-11-26
```

The restore refuses a volume that already exists, so it never overwrites data. Restore the lease directory too, or put back a lease sequence at least as high as the last one recorded: a lower sequence makes boards refuse new leases.

## Upgrade

1. Take a backup.
2. Stop the deployment.
3. Check out the new commit.
4. Launch again.

The services migrate the database as they start, and `/provenance` then names the new commit. To roll back, restore the backup into a new volume, check out the old commit and launch with that volume. Migrations don't run backwards.

## Key rotation

These steps are documented but not yet exercised by the regtest proof.

- **Gate Pass signing key:**
  1. Generate a new keys directory.
  2. Copy `postgres-credential.json` into it, since the volume's password must stay the same.
  3. Add the old public key's entry to the new `gate-pass-public-keys.json` array.
  4. Relaunch. Passes the old key signed stay valid for their 120 s.
  5. After that, remove the old entry and relaunch.
- **Reference Relying Service credential:** it links two of your own services, so a new one takes effect at relaunch.
- **Stratum credential key:** rotating it invalidates live lease credentials, so rotate it when no lease is active.
- **Work Lease Authority key:**
  1. Run `bun scripts/worker-development-authority.ts rotate --directory DIR --role lease`.
  2. Publish an owner trust that names the new key. The launcher refuses an active lease key the trust doesn't name.
  3. Relaunch.

## Proving it

```bash
scripts/rehearse-self-host.sh
```

This regtest proof uses generated test keys. It checks the following:

- Configuration refusals, and a launch whose pool never answers refusing at its readiness deadline.
- A launch through `self-host-gate.sh`, and `/healthz`, `/readyz`, `/provenance` and discovery.
- A claimant's journey through the deployment's own page, in a headless Chrome:
  - the claimant chooses the standard Worker and gives consent;
  - a CPU miner configured from the shown settings mines real shares past a Renew;
  - the claimant cancels, the page withdraws the settings and the miner is cut off.
- A backup while running, a restore into a new volume, and a relaunch on it with the journey's challenge present.
- No private value in any log.

A regtest CPU miner can't reach the Standard policy's Work Requirement, so the proof issues no Gate Pass. `scripts/rehearse-production-path.sh --standard-worker` covers issuance and redemption with the same services and page.
