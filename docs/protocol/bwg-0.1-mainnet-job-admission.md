# BWG/0.1 Mainnet Job Admission Profile

The BWG mainnet profile never releases `mining.notify` until the exact pinned P2Poolv2/Hydra job
variant has passed independent local Reward Policy checks and Bitcoin Core BIP 23 proposal mode.
Mainnet enables this gate unconditionally; configuration cannot select the legacy allow-all path.
Non-mainnet deployments may opt in to the same gate for deterministic evidence.

## Exact candidate and policy

Hydra constructs one unadmitted per-connection variant after fixing the assigned `extranonce1`,
pool commitment, pool timestamp, payout-bearing coinbase, template transactions, previous block,
version, target bits, and optional BIP 23 `workid`. A canonical zero `extranonce2`, header time from
the template, unmodified version, and zero nonce select one structurally complete member of the job
family. The receipt digest also binds the closed Worker-mutation profile: `extranonce2`, bounded
header time, negotiated version bits, and nonce. No payout, transaction, target, previous-block, or
pool-owned coinbase field is mutable.

Before RPC, local validation independently proves:

- the header previous block and expanded target equal the parsed template;
- every non-coinbase transaction count, txid, and wtxid matches the template in order;
- the transaction merkle root and SegWit witness commitment are valid;
- the optional `workid` is bounded and printable; and
- the coinbase has exactly the selected direct-payout output for the full available reward plus the
  zero-value witness commitment, with no pool fee, service fee, donation, or custodial balance.

The exact serialized block is then sent to the configured Bitcoin Core using
`getblocktemplate` with `mode: "proposal"`, echoing `workid` when Core supplied it. Only JSON `null`
is success. Every string—including `duplicate`—object, malformed or RPC error response, missing
input, policy mismatch, timeout, unavailable validator, or superseded generation withholds the job.

## Bounded failure and concurrency

`job_admission_timeout_ms` is constrained to 1–60,000 ms and
`job_admission_max_concurrency` to 1–1,024. A shared semaphore bounds proposal calls before Bitcoin
Core, and the deadline covers both queueing and RPC. A shared generation gate serializes template
publication with the final identity check, tracker insertion, and socket write. A late success for
an older generation therefore creates no tracker entry and releases no bytes; a template update
cannot enter between the check and release. Socket release is capped at 250 ms; a failed or partial
write removes that exact tracker job, releases the generation gate, and closes the connection so
untrusted network backpressure cannot block template publication.

A new Bitcoin tip removes every tracker job for an older tip and closes existing Stratum
connections. Workers reconnect to validate the current tip; they cannot continue submitting an old
job while availability pressure bypasses validation. Same-tip rejection leaves the last admitted
job usable only within its existing lifetime. The network-target submit path remains unchanged and
continues to call Bitcoin Core before pool accounting or BWG persistence.

Observability is metadata-only: category, bounded latency, job ID, and the SHA-256 candidate digest.
Credentials and payout identities are never logged.

## Reproducible evidence

[`provenance.json`](../../integration/hydra-solo/provenance.json) pins the exact upstream source,
license, Bitcoin Core artifact, deterministic regtest patch, production Job Admission patch, and
every SHA-256 digest. Run:

```bash
scripts/verify-hydra-solo-integration.sh
```

The runner checksum-verifies and applies both patches, executes the upstream fail-closed regression
suite, launches the external processes, and performs the complete Worker journey before and after a
Hydra restart. The deterministic regtest profile enables the same gate used mandatorily on mainnet,
so every observed `mining.notify` follows an actual Bitcoin Core JSON-null proposal result. Evidence
under `artifacts/hydra-solo-integration/` records source pins, policy configuration, accepted
candidate digests and latency, admission counts, Bitcoin Core version/result semantics, restart,
block submission, and bounded cleanup. The runner uses an ephemeral RPC secret, scans every log for
RPC, payout, mining, and service secret values before copying it, omits unsafe logs, and deletes the
entire credential-bearing temporary tree on success or failure. This is executable mainnet-profile
evidence, not a claim that live mainnet funds or traffic were used.
