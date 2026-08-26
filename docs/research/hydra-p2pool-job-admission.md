# Hydra/P2Pool Job-Admission Seam Research

## Scope and conclusion

This note traces the source identified locally as P2Poolv2/Hydra `v0.12` and answers the
Ticket 16 seam question against primary sources.

The smallest defensible extension is a generic, asynchronous **job-variant admission hook** in each
authorized connection task, after Hydra has applied every pool-generated per-connection coinbase
field and assembled a canonical full block, but before it inserts the job into the tracker or writes
`mining.notify` to the Worker. The internal `PreparedNotifyParams` watch channel may continue to
carry shared construction inputs because it is not Worker-visible. The hook must accept only an
explicit BIP 23 `null` response and release only the exact variant it approved. It must not run on
the block-submission path.

There is an important precision point: a Stratum V1 job describes a block family, not one final
byte string. The Worker chooses extranonce2, time, nonce, and possibly negotiated version bits;
Hydra assigns extranonce1 per connection. The pre-notification proposal can nevertheless be a
complete canonical member of that family. BIP 23 excludes proof of work from proposal validation
and lets a client assume continued validity only for the coinbase scriptSig portion that client
supplied and the header time. Hydra's commitment hash and nanosecond timestamp are pool-generated,
so they must be fixed in the proposed job variant; they cannot be treated as Worker mutations.
Therefore the admission artifact must contain:

- the exact previous block, version, target bits, transaction order and bytes from the template;
- the exact ordered coinbase outputs, including the witness commitment;
- the exact pool-generated commitment hash, nanosecond timestamp, assigned extranonce1, and every
  other pool-owned coinbase byte that the released notify will carry;
- a deterministic, structurally valid Worker extranonce2, time, version, and nonce;
- an explicit mutation profile enumerating only the fields the Worker may later vary.

This validates every immutable consensus and reward-bearing byte before work starts without
pretending that a Worker-selected nonce can exist before mining.

## Source pin and local evidence

The local design currently calls the source `P2Poolv2/Hydra v0.12` but does not record an
immutable commit. Upstream tag `v0.12.0` resolves to commit
[`8eca024bde6c2de74620dce2f9cc7fb9a544c5c0`](https://github.com/p2poolv2/p2poolv2/tree/8eca024bde6c2de74620dce2f9cc7fb9a544c5c0),
whose workspace manifest reports version `0.12.0` and license `AGPL-3.0-or-later`
([manifest](https://github.com/p2poolv2/p2poolv2/blob/8eca024bde6c2de74620dce2f9cc7fb9a544c5c0/Cargo.toml#L13-L25)).
The deployment pin should use that full SHA, not only the movable human-readable version.

The primary manifest's `AGPL-3.0-or-later` value exposed a stale `AGPL-3.0-only` disclosure in the
repository. Ticket 16 corrects the offer, protocol, browser fixtures, and design prose to match the
investigated source; Ticket 17 must still pin the deployment to the immutable SHA.

## Current template-to-notification path

At the pinned commit, the path is:

1. `BitcoindRpcClient::getblocktemplate` requests a template with `segwit` rules and the
   `coinbasetxn`, `coinbase/append`, and `workid` capabilities
   ([RPC client](https://github.com/p2poolv2/p2poolv2/blob/8eca024bde6c2de74620dce2f9cc7fb9a544c5c0/bitcoindrpc/src/lib.rs#L226-L245)).
1. `start_gbt` parses the response into `BlockTemplate` and sends
   `NotifyCmd::SendToAll { template }` on both polling and ZMQ-triggered refreshes
   ([GBT worker](https://github.com/p2poolv2/p2poolv2/blob/8eca024bde6c2de74620dce2f9cc7fb9a544c5c0/p2poolv2_lib/src/stratum/work/gbt.rs#L85-L180)).
1. The notifier computes `Vec<OutputPair>` from the template's coinbase value and current payout
   state, then supplies it to `PreparedNotifyParamsBuilder`
   ([output construction](https://github.com/p2poolv2/p2poolv2/blob/8eca024bde6c2de74620dce2f9cc7fb9a544c5c0/p2poolv2_lib/src/stratum/work/notify.rs#L45-L119)).
1. The builder constructs a complete dummy coinbase from the output distribution, height,
   witness commitment, pool signature, commitment hash, timestamp, and an extranonce separator.
   It splits that coinbase into Stratum `coinbase1` and `coinbase2`, computes template merkle
   branches, and creates the prepared JSON template
   ([prepared builder](https://github.com/p2poolv2/p2poolv2/blob/8eca024bde6c2de74620dce2f9cc7fb9a544c5c0/p2poolv2_lib/src/stratum/work/prepared_notify.rs#L237-L353)).
1. `publish_prepared_notify` immediately puts the prepared object on a Tokio watch channel; there
   is no admission callback between construction and publication
   ([publication seam](https://github.com/p2poolv2/p2poolv2/blob/8eca024bde6c2de74620dce2f9cc7fb9a544c5c0/p2poolv2_lib/src/stratum/work/notify.rs#L142-L220)).
1. Each authorized connection receives that prepared object, derives a per-miner commitment and
   timestamp, allocates a job ID, inserts the job into the tracker, and returns serialized
   `mining.notify`
   ([per-miner construction](https://github.com/p2poolv2/p2poolv2/blob/8eca024bde6c2de74620dce2f9cc7fb9a544c5c0/p2poolv2_lib/src/stratum/work/prepared_notify.rs#L400-L458)).
   The connection handler then writes it directly to the socket
   ([socket release](https://github.com/p2poolv2/p2poolv2/blob/8eca024bde6c2de74620dce2f9cc7fb9a544c5c0/p2poolv2_lib/src/stratum/server.rs#L478-L555)).

The current builder already has every reward-bearing value before publication. The coinbase
builder turns `OutputPair` values into `TxOut` values and appends the template witness commitment
([coinbase outputs](https://github.com/p2poolv2/p2poolv2/blob/8eca024bde6c2de74620dce2f9cc7fb9a544c5c0/p2poolv2_lib/src/stratum/work/coinbase.rs#L63-L86),
[transaction construction](https://github.com/p2poolv2/p2poolv2/blob/8eca024bde6c2de74620dce2f9cc7fb9a544c5c0/p2poolv2_lib/src/stratum/work/coinbase.rs#L107-L174)).
The existing upstream integration test reconstructs outputs from the resulting `coinbase2` and
asserts that the two payout outputs and witness commitment are preserved
([test](https://github.com/p2poolv2/p2poolv2/blob/8eca024bde6c2de74620dce2f9cc7fb9a544c5c0/p2poolv2_lib/src/stratum/work/notify.rs#L472-L565)).

## Existing BIP 23 helper: callable shape and wrong success contract

The pinned tree contains `validate_bitcoin_block`, which serializes a `bitcoin::Block`, invokes
`getblocktemplate` with `mode: "proposal"`, and returns `true` only when the JSON result equals the
string `"duplicate"`
([helper](https://github.com/p2poolv2/p2poolv2/blob/8eca024bde6c2de74620dce2f9cc7fb9a544c5c0/p2poolv2_lib/src/shares/validation/bitcoin_block_validation.rs#L22-L48)).

It is not callable from the notifier today:

- its containing module is private (`mod bitcoin_block_validation`)
  ([module declaration](https://github.com/p2poolv2/p2poolv2/blob/8eca024bde6c2de74620dce2f9cc7fb9a544c5c0/p2poolv2_lib/src/shares/validation/mod.rs#L17));
- repository-wide source search finds no production call site;
- `#[allow(dead_code)]` on the function confirms it is intentionally unwired;
- its positive unit test mocks `"duplicate"`, so it demonstrates post-discovery recognition, not
  pre-work acceptance
  ([existing test](https://github.com/p2poolv2/p2poolv2/blob/8eca024bde6c2de74620dce2f9cc7fb9a544c5c0/p2poolv2_lib/src/shares/validation/bitcoin_block_validation.rs#L61-L110)).

That boolean contract is the opposite of the required pre-work contract. BIP 23 requires a
hex-encoded full block in proposal mode, excludes proof of work from validation, and defines JSON
`null` as acceptable as-is; strings and delta objects are non-success responses
([BIP 23 block proposal](https://github.com/bitcoin/bips/blob/7fe0b034ec967b52a5a28276419117326df93263/bip-0023.mediawiki#L73-L97)).
Bitcoin Core v30.2 implements the same rule: a valid validation state maps to null
([result conversion](https://github.com/bitcoin/bitcoin/blob/4d7d5f6b79d4c11c47e7a828d81296918fd11d4d/src/rpc/mining.cpp#L585-L602)),
while `"duplicate"` is returned only when the proposed block hash is already indexed
([proposal path](https://github.com/bitcoin/bitcoin/blob/4d7d5f6b79d4c11c47e7a828d81296918fd11d4d/src/rpc/mining.cpp#L729-L750)).

Three local, disposable checks were run against the exact upstream SHA:

```text
cargo test -p p2poolv2_lib shares::validation::bitcoin_block_validation
result: 3 passed; 0 failed

# Added a throwaway mock returning JSON null, then ran:
cargo test -p p2poolv2_lib test_validate_bitcoin_block_prework_null_is_currently_false
result: 1 passed; the current helper returned Ok(false)

cargo test -p p2poolv2_lib test_build_notify_and_extract_outputs_integration
result: 1 passed; the prepared notify preserved the exact payout and witness outputs
```

The replacement should not return a bare boolean. Use an explicit result such as
`Result<ProposalAccepted, ProposalError>` and construct `ProposalAccepted` only for JSON null.
Classify every string, object, malformed response, transport error, timeout, missing capability,
and RPC error as fail-closed non-acceptance. For a new job, `duplicate`, `duplicate-invalid`, and
`duplicate-inconclusive` are not pre-work success.

There is one additional BIP 23 gap: the GBT request asks for `workid`, but `BlockTemplate` has no
`workid` field
([template type](https://github.com/p2poolv2/p2poolv2/blob/8eca024bde6c2de74620dce2f9cc7fb9a544c5c0/p2poolv2_lib/src/stratum/work/block_template.rs#L35-L76)).
BIP 23 requires a provided `workid` to be echoed in the proposal. Add optional `workid` to the
parsed template and proposal request. The template request should also advertise the `proposal`
capability explicitly.

## Runnable pinned-source prototype

The durable prototype is pushed on
[`codex/prototype-hydra-job-admission`](https://github.com/bright-builds-llc/bitaxe-turnstile-system/tree/e79793016637d6ac8a438c8088b214f0eed69d0f/docs/design/prototypes)
at commit `e797930`. Its one-command runner clones the exact upstream SHA, applies the preserved
source patch, and runs the focused upstream tests. The patch uses the real
`PreparedNotifyParamsBuilder`, factors construction into an `UnadmittedJobVariant`, applies an
actual miner-address commitment, fresh pool nanosecond timestamp, and assigned extranonce1, then
assembles the full canonical `bitcoin::Block`. Coinbase outputs are derived only from that block.
Tracker insertion and notify-byte release occur in a separate final function.

Observed results against the clean pinned checkout:

```text
cargo test -p p2poolv2_lib prototype_
result: 2 passed; 0 failed

prototype_exact_candidate_and_outputs_are_admitted_before_job_release
- the real builder produced a full block and exact payout/witness outputs;
- while admission was blocked, the exact job ID was absent from the real JobTracker;
- after acceptance, the same variant entered the tracker and released mining.notify bytes.

prototype_late_success_cannot_publish_a_stale_job_variant
- generation N was blocked while N+1 became current;
- N's later success created no tracker job;
- the current exact N+1 variant could be admitted and published.

cargo test -p p2poolv2_lib test_validate_bitcoin_block
result: 3 passed; 0 failed

cargo test -p p2poolv2_lib test_build_notify_and_extract_outputs_integration
result: 1 passed; 0 failed
```

The branch also retains the earlier single-file state lab for manually exploring rejection,
timeout, stale-tip, rollback, and independent block-submission outcomes. That HTML is explanatory;
the pinned Rust patch and tests are the runnable seam proof.

## Recommended generic interface and placement

Keep construction pure and I/O in the connection task:

```rust
pub struct JobAdmissionCandidate {
    generation: PreparedGeneration,
    canonical_block: Arc<bitcoin::Block>,
    allowed_worker_mutations: AllowedWorkerMutations,
    maybe_work_id: Option<WorkId>,
}

impl JobAdmissionCandidate {
    pub fn coinbase_outputs(&self) -> &[bitcoin::TxOut] {
        &self.canonical_block.txdata[0].output
    }
}

#[async_trait]
pub trait JobAdmission: Send + Sync {
    async fn admit(
        &self,
        candidate: &JobAdmissionCandidate,
    ) -> Result<AdmissionReceipt, JobAdmissionError>;
}
```

Names may change, but the interface constraints should not:

- It is a pool-level job-validation interface; it contains no BWG Challenge, Protected Action,
  Gate Pass, claimant, or gate-accounting type.
- A fallible constructor rejects an empty block and derives outputs exclusively from the canonical
  block's coinbase, so a caller cannot supply disagreeing block and output representations.
- `PreparedGeneration` is a monotonic non-zero identity and `WorkId` is a validated bounded opaque
  value, not an unconstrained integer or string.
- Every pool-generated field—miner-address commitment, nanosecond timestamp, assigned extranonce1,
  pool signature, fee, donation, and payout bytes—is frozen before candidate construction.
- `AllowedWorkerMutations` is closed and typed: Worker extranonce2, bounded header time, negotiated
  version bits, and nonce. Output, transaction, previous-block, target, pool commitment, assigned
  extranonce1, and pool timestamp changes are never admissible mutations.
- `AdmissionReceipt` binds a digest of the canonical block, mutation profile, optional work ID,
  validation source, and exact job-variant generation. It is not transferable to a later rebuild.
- A no-op allow-all implementation may preserve upstream compatibility, but the BWG deployment
  profile must fail startup unless a required admission implementation is configured.

Split `build_notify_from_prepared` into pure construction of an `UnadmittedJobVariant` and a final
tracker/publication step. The pure step receives the connection's assigned extranonce1, applies the
miner-address commitment and fresh nanosecond timestamp, and produces both notify bytes and the
canonical block. The connection task awaits `admit`, rechecks that its prepared generation is still
current, then atomically inserts the exact variant in the tracker and writes its already-bound
notify bytes. A rejection never creates a mineable tracker entry.

The canonical block is straightforward to assemble with existing code: use the constructed
coinbase—including the connection's pool-generated fields and assigned extranonce1—plus a canonical
zero Worker extranonce2, decode the template transactions, derive the merkle root from that coinbase
and the already-computed branches, and create a header from template version, previous block,
`curtime`, bits, and nonce zero. BIP 23 deliberately skips proof of work. Outputs are always read
from `canonical_block.txdata[0].output`.

## Operational consequences

### Failure

- Any policy mismatch, proposal rejection, non-null result, timeout, unavailable RPC, malformed
  response, absent required template data, or lost result channel must prevent publication.
- If the rejected candidate has a different previous block from the last admitted generation,
  immediately revoke old jobs and disconnect or explicitly pause authorized Stratum sessions.
  Continuing old-tip work while the replacement is rejected is not fail closed.
- A same-tip refresh may keep the last admitted job only while its own bounded lifetime remains
  valid. It must never publish the rejected refresh.
- Record bounded category, latency, generation, and candidate digest only; do not log credentials
  or payout identity beyond the deployment's approved observability profile.

### Latency

- Admit every distinct exact job variant. Coalesce only byte-identical candidate digests; never
  reuse a receipt merely because variants share a prepared template. If RPC capacity cannot support
  the connected Worker count, bound admission concurrency and backpressure or reject new jobs.
- Apply a configured deadline shorter than the maximum useful job age. A timeout rejects that
  generation. Expose attempt duration and timeout counts.
- Same-tip validation can leave the previous admitted generation active. A new-tip event should
  revoke old work immediately, then release new work only after admission.

### Concurrency and stale results

- Do not await validation in a connection loop that cannot also observe a newer prepared template
  or disconnect. Select over admission, template change, and shutdown; cancel or discard superseded
  work through a monotonic prepared generation.
- Use latest-generation-wins socket release. A result whose prepared generation or exact candidate
  digest no longer matches current state is stale and must be discarded even if Bitcoin Core
  returned null.
- Bound concurrent proposal calls. Superseded tasks should be cancelled where safe, and late
  responses must remain harmless through the generation check.
- Recheck tip/generation immediately before publication. Bitcoin Core validates against its active
  chain at proposal time, but the notifier must close the race between an accepted response and a
  newer queued template.

### Rollback

- Rolling back or disabling the hook in the BWG mainnet profile must make the pool unavailable for
  new work; it must not silently restore pre-hook notify behavior.
- Keep the extension additive and configuration-gated upstream. Rollback can select an allow-all
  implementation for non-BWG deployments, while the BWG deployment's required-admission flag
  prevents fail-open operation.

### Block-submission independence

The pinned source already sends a network-target submission directly to Bitcoin Core as soon as a
share meets Bitcoin difficulty: it builds the full Worker-selected block and calls `submit_block`
before pool-difficulty accounting and share emission
([submit fast path](https://github.com/p2poolv2/p2poolv2/blob/8eca024bde6c2de74620dce2f9cc7fb9a544c5c0/p2poolv2_lib/src/stratum/message_handlers/submit.rs#L121-L150),
[block assembly and RPC](https://github.com/p2poolv2/p2poolv2/blob/8eca024bde6c2de74620dce2f9cc7fb9a544c5c0/p2poolv2_lib/src/stratum/message_handlers/submit.rs#L233-L260)).
Do not insert the admission hook, BWG event delivery, or Gate Authority calls into that path. The
pre-notification receipt authorizes release of a job family; it is not a prerequisite service call
when a rare valid block is found.

## Downstream implementation handoff

Tickets 17 and 18 should turn the validated prototype seam into production code and retain these
acceptance cases:

1. Construct an exact per-connection job variant and prove its canonical block's coinbase outputs
   exactly match the supplied distribution plus witness commitment.
1. Block the mock admission future and prove no tracker entry or `mining.notify` appears.
1. Resolve with explicit acceptance and prove the exact bound generation is published.
1. Return null from a mock Bitcoin Core proposal and prove acceptance; return every non-null class
   and prove rejection.
1. Queue generation N+1 while N is validating, then complete N successfully and prove N is never
   published.
1. Reject a different-tip generation and prove prior jobs are invalidated and sessions cannot keep
   mining the old tip.
1. Submit a network-target result through the existing submit path while gate accounting is
   unavailable and prove `submitblock` remains first and independent.

The first two and the latest-generation-wins case are already proven by the branch prototype; the
remaining cases belong in the production integration. With those tests, Ticket 17 can integrate the
exact source pin and Ticket 18 can implement the policy/BIP 23 adapter without reopening placement.
