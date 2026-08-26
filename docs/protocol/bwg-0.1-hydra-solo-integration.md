# BWG/0.1 Pinned Hydra Solo Integration

The reference integration runs P2Poolv2/Hydra `v0.12.0` at commit
`8eca024bde6c2de74620dce2f9cc7fb9a544c5c0` as a separate
`AGPL-3.0-or-later` process behind the MIT Pool Adapter. Normal product chrome exposes that full
version/commit identity. [`provenance.json`](../../integration/hydra-solo/provenance.json) pins the
upstream source and Bitcoin Core artifacts by SHA-256; no Hydra source is linked into the BWG crate.

## Solo direct-payout profile

One isolated Hydra instance serves one selected payout identity with zero pool and service fees.
The Pool Adapter authenticates the Worker's opaque short-lived credentials locally, then translates
only Pool-facing `mining.authorize` and `mining.submit` usernames to the selected Bitcoin address.
The address remains in adapter memory and Hydra's pool-local job/accounting state; it is not added
to Work Challenges, Accepted Work Events, Gate Authority persistence, BWG logs, governance exports,
or Worker-visible custom fields. Hydra's bootstrap and sole-user PPLNS output both resolve to the same selected address, so
the payout-bearing coinbase allocates 100% of available reward there plus the zero-value witness
commitment.

## Executable evidence

Run:

```bash
scripts/verify-hydra-solo-integration.sh
```

The macOS-arm64 runner verifies checksums, builds the exact external source with the isolated
regtest patch and production Job Admission patch, launches Bitcoin Core 28.1 and Hydra out of
process, and executes the ignored
real-integration test twice across a Hydra restart. The standard Worker traverses the real TCP
proxy, receives subscribe, difficulty, and notify messages, submits accepted work, and observes no
BWG extension. The test proves:

- the selected payout script is present in Hydra's actual coinbase;
- Hydra's live variable-difficulty controller changes the assigned share target after rapid valid
  shares, and the Worker then satisfies the adjusted target;
- an accepted response is durably queued and advances the existing Gate Authority progress path
  exactly once;
- an exact duplicate is rejected without another event;
- a new Bitcoin tip invalidates old tracker jobs and closes the connection before reconnect;
- reconnect receives fresh extranonce space and another valid job; and
- the same journey succeeds after the external Hydra process restarts over its existing store.

The source patch is isolated to this bounded test. It adds deterministic regtest genesis and address
handling, accelerates Hydra's existing variable-difficulty timing thresholds, and scales only the
wire difficulty so ordinary CPU test code can produce shares. Hydra's test configuration bypasses
its expensive production share threshold, while the Pool Adapter independently rejects any share
that misses the exact target Hydra assigned on the wire. The patch contains no Claimant, Work
Challenge, Protected Action, Gate Pass, or gate-accounting concept.

Every released job now passes the mandatory-mainnet Reward Policy and BIP 23 gate described in
[`bwg-0.1-mainnet-job-admission.md`](bwg-0.1-mainnet-job-admission.md). Network-target block
submission remains on Hydra's existing fast path before share accounting. The integration closes
Gate Authority/SSE, leaves the Relying Service absent, and stops PostgreSQL before submitting a
valid regtest block; Bitcoin Core still advances before the stalled observer is boundedly aborted.
The expanded outage, result-category, timing, reorg, and residual-risk contract is specified in
[`bwg-0.1-independent-block-submission.md`](bwg-0.1-independent-block-submission.md).
