# Self-hosted reference deployment (bwg-core Ticket 24)

The agent chose this design's defaults on 2026-11-26, under the owner's standing instruction to choose sensible defaults for software-only work, and built it. The owner reviewed it the same day and approved it with the decisions below. Calls still marked as the agent's were reviewed and kept.

## Owner decisions (2026-11-26)

- **First self-hoster:** the owner, on an arm64 Mac. macOS arm64 only is kept. A Linux port is a separate ticket for when someone else wants to self-host, because it means rebuilding and proving Hydra's pinned patches and the Bitcoin Core pin for another target.
- **Origin and node:** Tailscale or the self-hoster's own TLS proxy, and on mainnet the self-hoster's own synced node, reached by loopback RPC and ZMQ URLs. A node on another machine fits the external-node path.
- **Hydra's source:** Hydra is AGPL-3.0-or-later, and a deployment serves miners over a network. `/provenance` links the exact source it runs: Hydra's pinned upstream commit and this repository's patch files at the build's commit. A deployment serves no source archive of its own.
- **Closing the last acceptance item:** both of these, not the production-path rehearsal alone:
  - the Gate negatives harness, run on regtest against a deployment `self-host-gate.sh` launched;
  - one journey on the owner's mainnet self-hosted deployment, with a Bitaxe and the owner's node, from consent through Gate Pass redemption. It follows the hardware process rules and records redacted evidence.

## Intent

A self-hoster runs the whole reference BWG Core stack and gets the same public interfaces, trust controls, provenance, health signals and safety behaviour as the owner's deployment. It runs on their own machine, with their own keys and node. Today the owner's launcher (`scripts/launch-gate-deployment.sh`, Ticket 07) starts PostgreSQL, the Gate Authority, the Pool Adapter, the Reference Relying Service and the same-origin front. Hydra and Bitcoin Core start separately, data is lost at shutdown, provenance reads "Unavailable", and no signal says whether mining jobs are valid.

## Goals

- One supported launch path for the whole stack, from one configuration file.
- Configuration that keeps public endpoints, private links, trust roots, secrets, Pool Offers, Action Policies and payout terms apart.
- Startup that stops, and says why, when a pin, migration, key, Job Admission or dependency is missing.
- Provenance a visitor can read: discovery, source, version, commit, build, engine and licences.
- Health that says the application is up, and readiness that says Hydra is releasing valid mining jobs.
- Backup, restore, upgrade, key rotation, shutdown and recovery, documented and exercised on regtest.
- The public acceptance harness passing against a launched deployment, with no self-host-only protocol change.

## Non-goals

- A hosted multi-tenant service, container images, or orchestration (Kubernetes, systemd units).
- Linux or Intel Macs: the pinned Hydra and Bitcoin Core runners are macOS arm64 only, so this is too (owner's decision; a non-claim until a separate ticket ports the runners).
- New Pool Offers, Action Policies or payout terms. The configuration names the ones the reference supports and refuses others.

## Anti-goals

- A second launcher that drifts from the owner's. The self-host path wraps the same launcher, so both run the same code.
- Secrets in the configuration file, a command line, the repository or a log.
- A readiness signal that reports ready while Hydra withholds jobs.

## Approaches

1. **Wrap the owner's launcher (chosen, agent's call).** A small config validator and wrapper start Hydra, then run `launch-gate-deployment.sh` with the derived flags. The launcher gains what both deployments need: persistent PostgreSQL, build provenance, health, readiness, and visible startup failure. It reuses everything Ticket 07 proved, and the owner's deployment gains the same signals.
2. **Container images and Compose.** These are portable and familiar to operators, but they would rebuild Hydra's pinned patches and the browser bundle in images, and they'd be a second path to keep equal to the owner's. Rejected for now.
3. **A Rust supervisor binary.** It's typed and testable, but it would duplicate the launcher's checks in another language for no new behaviour. Rejected.

## Design

### Launch (`scripts/self-host-gate.sh --config FILE`)

- It validates the configuration (`scripts/self-host-config.ts`, unit-tested), then starts the pinned stack.
  - On regtest it starts its own node and Hydra, reusing `hydra-regtest-stack.sh`.
  - On mainnet it starts Hydra against the self-hoster's synced node, reusing `hydra-mainnet-stack.sh --external-node`.
- It runs `launch-gate-deployment.sh` with the derived flags and holds until Ctrl-C or a process exits.

### Configuration (`bwg-self-host/0.1`, JSON)

Each section has one kind of value:

- `public`: the origin. It is either `tailscale`, or an `https://` origin whose TLS the self-hoster's own proxy terminates in front of the loopback front.
- `private`: the proxy's LAN address and port, the run directory, and the PostgreSQL volume name.
- `node`: `managed` (regtest only), or an external node's loopback RPC and ZMQ URLs and the path of its credentials file.
- `trust`: the Worker deployment trust file and the C image directory.
- `secrets`: the paths of the Gate keys directory and the Work Lease Authority directory, never their values. Every secret path must be absolute and outside the repository. A field that looks like a secret value is refused.
- `poolOffers`: the engine (`hydra`), the payout model (`claimant_selected`), and the operator's Hydra solo address.
- `actionPolicies`: the policies the Authority may issue, only `account-creation.standard.v1` today.
- `payoutTerms`: an optional Work Requirement within the Standard policy's override bounds.
- `standardWorker`: an optional disclosure for the "Use another Stratum V1 Worker" choice. When it's absent, the page offers the Bitaxe only.

Unknown fields are refused, so a misspelt section fails at startup, not at a claimant's journey.

### Startup failures

The launcher already refuses missing commands, keys with loose modes, a lease key outside the owner trust, and a missing upstream. It gains three more checks:

- A child process that exits before its port opens stops the launch and prints its log's tail. A failed migration is one such exit.
- The pinned Hydra and Bitcoin Core are verified by digest as the stack scripts do today.
- Startup waits up to 180 s for readiness and fails with its reason, such as "no admitted mining job".

### Provenance

- The launcher builds with `BWG_BUILD_COMMIT` (the commit, with `-dirty` for a dirty tree) and `BWG_BUILD_TIME`, so discovery's `source` is filled.
- The front serves `GET /provenance`, a JSON document with:
  - the discovery URL, and the source repository, version, commit and build time;
  - the engine: Hydra's version, commit and patches, with links to its pinned upstream commit and to each patch file at the build's commit, which meets Hydra's AGPL source offer (owner's decision);
  - Bitcoin Core's pinned version;
  - the licences: the project's MIT, Hydra's AGPL-3.0-or-later, and Bitcoin Core's MIT.

### Health and readiness (front)

- `GET /healthz` means the application is available: the Authority's discovery and the Reference Relying Service both answer. Otherwise it answers 503 and names the part that didn't.
- `GET /readyz` means health, plus valid mining-job readiness. A Stratum probe to Hydra subscribes, authorizes as the operator's solo address, and must receive a `mining.notify` within 10 s.
  - Hydra releases a job only after Job Admission, so a notify is an admitted job.
  - The result is cached for 30 s, so probing stays light.
  - It answers 503 with the failed check otherwise.

### Data and operations

- PostgreSQL keeps its data in a named Docker volume instead of the throwaway container's filesystem. The owner's Ticket 07 runs keep the throwaway default.
- `scripts/self-host-operations.sh backup|restore` dumps or loads the three databases.
- **Upgrade** is: back up, stop, check out the new commit, launch. The services run their migrations at start.
- **Key rotation** follows the keys script. A new Gate Pass key is added to the JWKS beside the old one until every pass signed by the old key has expired, at 120 s. Work Lease Authority keys rotate through the owner trust, as Ticket 07 records.
- **Shutdown** is Ctrl-C, which records the lease sequence's high-water mark.
- **Recovery** is a relaunch: the lease sequence starts above every sequence a board has seen.
- `docs/operations/self-hosted-deployment.md` holds the runbook, and a regtest script exercises backup, restore and relaunch.

### Acceptance

A regtest proof, `scripts/rehearse-self-host.sh`, drives the page of a deployment that `self-host-gate.sh` launched, through public interfaces only. Its Worker is the standard Stratum V1 Worker, a CPU miner configured from the settings the page shows. The claimant gives consent, mines real shares past a Renew, then cancels; the proof checks that the page withdraws the settings and the Pool Adapter cuts the miner off.

The proof doesn't cross the Work Requirement, so it issues and redeems no Gate Pass. (Revised during the build: the simulated outbox share the production-path rehearsal uses is guarded so that it can't reach a launched deployment, `tests/rehearsal_isolation.rs`, and a regtest CPU miner earns about one hash of credit per share against at least 2^43.) Issuance and redemption with a standard Worker are the production-path rehearsal's (`--standard-worker`), which runs the same services and page. No route, field or behaviour exists only for self-hosting.

The last acceptance item closes on two more pieces (owner's decision):

- `scripts/rehearse-self-host.sh` also runs the Gate negatives harness against the deployment it launched, on regtest.
- One mainnet journey on the owner's self-hosted deployment, with a Bitaxe and the owner's node. A Bitaxe earns the Work Requirement's 2^43 hashes in seconds, so the journey runs from consent through issuance and redemption of a Gate Pass. Its evidence names the board, commit and build, is free of addresses, credentials and pool identities, and lists its non-claims.

## Left to the builder

- Port numbers, timeouts and file names not fixed above.
- How the probe's Stratum exchange is framed.
- Whether a check sits in the wrapper or in the launcher, so long as the owner's deployment gains the same signals.
