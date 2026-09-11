# Worker serial transport 0.2

This is the active fixed ESP32-S3 Serial/JTAG profile, under ADR 0096. It
replaces serial 0.1 without an active compatibility fallback. Controller 0.4,
possession 0.2 and their role-separated authorization contracts remain.

## Wire records and integrity

Records are UTF-8 JSON objects followed by one LF. Their exact fields are
`profile`, `kind`, `sessionId`, `sequence`, `payloadBytes`, `payloadSha256`,
and `payload`. Profile is `bwg-worker-serial/0.2`; kinds remain `session`,
`control`, `heartbeat`, and `diagnostic`. Existing session-token, u32 sequence,
payload-object, duplicate-key and extra-field rejection rules remain.

The complete record, including LF, is at most 66,560 bytes. A control payload
is at most 65,536 bytes. `payloadBytes` is the exact UTF-8 byte length of the
payload JSON value, excluding whitespace outside that value. `payloadSha256`
is its canonical unpadded base64url SHA-256 digest. Whitespace, key order and
escapes inside the value are hashed exactly as transmitted. Receivers must
retain the raw payload span; JSON parsing followed by serialization is not an
integrity check. Verify integrity before processing any record, including
heartbeats and receive acknowledgements. Never log hashes or payload contents.

## Signed manifest

Retain the existing manifest fields and values, changing its profile to 0.2
and adding these exact fields:

| Field                            | Value                    |
| -------------------------------- | ------------------------ |
| `hostToDeviceReceiveWindowBytes` | `2048`                   |
| `maximumHostWriteChunkBytes`     | `1024`                   |
| `recordWriteTimeoutMilliseconds` | `2000`                   |
| `payloadIntegrity`               | `sha256_exact_utf8_json` |

The complete manifest is signed through the existing capability and bound into
fresh possession with exact firmware and logical-session identity. Hello
cannot enlarge the manifest's window or change integrity semantics.

## Bootstrap and receive credit

The existing `session`/`hello` record is uncredited and must itself fit 2,048
bytes. The host sends no subsequent bytes before validating `hello_ack`.
The acknowledgement retains its existing fields and adds
`receiveWindowBytes: 2048` and `receivedBytes: 0`. This admits transport only;
possession and Work authorization remain separate.

Both cumulative byte counters start at zero immediately after the Hello LF.
Do not attribute a whole read batch to one epoch if it crosses that boundary.
Every later raw host byte, including delimiters, partial records and
heartbeats, counts against the window.

Firmware sends a sequenced, integrity-protected `session` record with exactly
this payload shape whenever receive progress advances:

```json
{"op":"receive_credit","receivedBytes":1024}
```

`receivedBytes` is the cumulative u32 count actually drained from the native
receive driver in that session. Coalescing intermediate counts is allowed;
withholding progress until a complete record or a full window is not. Credit
production and the sole output writer must run independently of blocking
Start, Renew, Restore, logging and NVS work. Preserve heartbeat priority, then
credit priority ahead of control replies and diagnostics. Discard old-epoch
credit on closure.

The host reserves/debits bytes before calling native `writer.write`, then
writes at most 1,024 bytes and never exceeds 2,048 reserved but unacknowledged
bytes. Acknowledgements may arrive before native write promises settle. Require
strictly advancing credits no greater than bytes reserved for send. Reconnect
before u32 exhaustion; never wrap or refund failed writes. A record's send
resolves only after acknowledgement of its complete cumulative byte count.

Device-to-host records retain native TX backpressure and gain the same payload
integrity validation. Receive-credit records do not themselves require credit
and never refresh heartbeat clocks, possession freshness or Work Leases.

A complete validated Close revokes Work authority immediately. Its closing
transport epoch may emit one bounded final consumption credit, within 2000 ms,
only while no newer Hello has begun. This receipt permits the host's final send
to settle; all other retired-epoch credits, controls and heartbeats are discarded.
Native output admission is rechecked at bounded nonblocking write attempts and
flush polls. Bytes already admitted to native TX cannot be retracted.

Before the matching fresh Hello acknowledgement, the host may discard at most
32 integrity-valid old device records: receive credits, Controller response
envelopes, possession response envelopes, heartbeats, diagnostics, and structurally
valid Hello acknowledgements for a different host nonce. Incoming Hello/Close, invalid response envelopes,
and sequence-zero non-acknowledgements fail. A matching host nonce is never
discarded: its acknowledgement must pass all manifest and identity checks.
Old possession responses use the existing possession response/claims parser for
structural validation only. They never establish possession or verify a new
transcript; the new session still requires its own complete fresh proof.
Discarded records grant no authority, update no counter or history, publish no
diagnostic observation, and reset no deadline. No command is replayed.

To resynchronize interrupted output, one malformed UTF-8/JSON protocol line
terminated by LF may also be discarded. All skipped original wire bytes,
including delimiters, whitespace, that prefix and boot text, share an aggregate
66560-byte budget. The fresh acknowledgement has its own normal record bound.
Valid JSON with wrong profile, fields or integrity still fails. Bootstrap
exceptions end synchronously at the validated fresh acknowledgement's delimiter,
before processing subsequent bytes in the same read; active-session parsing
remains strict. A stale acknowledgement cannot end or renew bootstrap.

## Deadlines, ordering and cancellation

One 2,000-ms write deadline covers a complete record, all native chunks, credit
waits and its final consumption acknowledgement. Do not restart it per chunk.
After heartbeat admission, send a fresh heartbeat before a potentially long
indivisible control record. Retain one-second heartbeats, the 2.8-second device
deadline and the three-second gate-closure/shutdown-initiation requirement.

Assign output sequences only when a record is selected for transmission.
Priority must never transmit a higher assigned sequence before a queued lower
one. Maintain one output owner and never interleave bytes from two records.

Cancellation stops future bytes and heartbeats for an unfinished record. It
must release credit waiters and cannot append Restore or Close inside partial
JSON, finish a cancelled command, or restart from a late credit. Use independent
device-local revocation and fresh-session restoration evidence in that case.
No automatic command replay or reconnect is permitted.

## Qualification-only read interruption

`interruptPendingStatusForQualification()` is an explicit qualification-hook
operation, also exposed by the acceptance page. It introduces no new wire
message. Require a fresh parsed baseline with no lease, then hold exclusive
operation ownership for the same connection generation. Send one ordinary
Controller status request and await the normal channel send, including final
device receive credit under the unchanged write deadline. If its correlated
response is still pending, revoke that browser generation and close streams,
port and origin ownership without appending Restore, Close or another request.
Missing credit, identity/generation loss, unsafe state and cleanup failures
cannot produce a successful interruption receipt.

The success receipt is exactly:

```json
{"schema":"worker-read-interruption-v1","interrupted":true,"request_consumed":true,"response_pending":true,"ownership_released":true}
```

If the response already arrived, return the same schema with
`request_consumed: true` and the other three booleans `false`; no interruption
occurred and ownership remains open. This operation cannot sign or grant work,
change a mining allowance, manufacture device traffic, or reconnect
automatically. Heartbeat and device safety deadlines remain unchanged.

The receipt proves only the observed consumed-request/pending-response/cleanup
boundary. It does not prove that firmware queued a complete reply. Fresh-session
recovery must separately observe `helloRecovery.discardedReplies > 0` for a
validated old Controller or possession response, with exact runtime identity,
unchanged accounting/settings and final cleanup under the firmware-owned task.

## Required verification

Exercise the production channel against a 4,096-byte, 64-byte-packet bounded
receiver with deliberately paused draining. Reproduce the uncredited loss;
prove bounded outstanding data and exact delivery when draining resumes.
Verify removed/duplicated bytes, lexical JSON variants, wrong digests/lengths,
old or excessive credits, overflow, lost acknowledgements, partial-record
cancellation, large records near heartbeat boundaries and blocked command
owners. No corrupt record may reach controller dispatch and no revoked send
may emit additional bytes. Diagnostics expose closed categories and bounded
counts only. Real-device timing and four-cycle qualification remain separate.

## Admission diagnostics and budget review

The existing diagnostic record may carry the closed `worker_admission schema=v1`
line. It reports `stage` (idle, admission, readiness, preparation, pool_activation,
active, cleanup, complete), `first_failure` (none, admission, readiness,
preparation, pool_activation, cleanup), `readiness` (0–63),
`budget_reserved_ms` (0–240000), `budget_complete` (true/false), and
`redacted=true`, in that exact order. Readiness bits 0 through 5 mean run intent,
network connected, protocol supported, fresh safety prerequisites, lease
available, and actuation owners available. These boot-local cached observations
may span transitions and contain no campaign or session identity. They are
explicitly nonauthoritative and must never authorize work, budget reuse, or
restoration. The producer retains the first failed boundary through cleanup;
only beginning a new admission clears it. The sole writer samples the atomics
at most once per second, below control, heartbeat, and receive-credit traffic,
without accessing NVS or waiting for a blocked Start.

Controller 0.4 additionally accepts `acceptance_budget_review` with the exact
payload `{ "campaignId": "<canonical base64url encoding of 16 bytes>" }`.
It requires fresh possession, no active lease, and completed restoration. The
read-only result contains exactly `schema: "worker-budget-review-v1"`,
`campaign_match` (boolean), `reserved_mask` and `completed_mask` (integers 0–7),
`charged_ms` (integer 0–240000), and `pending` (boolean). Completed bits must be
reserved, with at most one outstanding bit, and pending equals whether the masks differ.
Charged milliseconds equal the reserved mask weighted by 180000, 30000, and
30000 for windows zero, one, and two. The identifier is never
echoed or included in diagnostics. This response remains available when no
mining generation timing exists. It observes the durable ledger and neither
reserves nor refunds a window; callers must match the original campaign before
using it to assess remaining acceptance work. The Web Serial adapter exposes
`acceptanceBudgetReview(campaignId)`; the qualification page exposes
`reviewBudget(campaignId)` and returns only the validated closed result.

The qualification-only `rejectStartForRecoveryTest()` helper uses fresh possession
and a synthetic non-campaign grant with an all-zero signature, never the signing
endpoint or operational pool inputs. Success requires the correlated Controller
rejection `{code: "command_rejected", message: "authentication_failed"}`.
Timeout, diagnostic-only failure, or any other rejection fails the test. The
adapter releases the rejected epoch without appending another control record.
A fresh explicit connection and unchanged durable budget review are separate
required recovery postconditions. `submitBudgetReview()` keeps the proof binding
private while recording the closed report with the local supervisor; its next
Start-authorization preparation reuses that same fresh proof once.

The public Controller serial request codec accepts the same exact budget-review
payload and rejects missing, extra, noncanonical or incorrectly sized identifiers.
Shared examples are in `conformance/bwg-worker-controller-0.4/budget-review-vectors.json`;
`contract.schema.json` defines `acceptanceBudgetReviewRequest` and
`acceptanceBudgetReviewResult`. Runtime validation enforces the relationships
between mask bits, charges and pending state. The deterministic generic simulator
has no possessed durable ledger and rejects this operation explicitly.

## Fan-only qualification

The qualification-hook-only SDK operation `qualificationCooling(action)` sends
Controller 0.4 `qualification_cooling` with the exact payload
`{ "action": "prove_fan" }` or `{ "action": "restore_baseline" }`. It requires
an admitted connection without an active lease, and obtains fresh possession
before proving the fan. This operation uses neither a signer nor pool inputs,
dispatches no ASIC work, and creates no mining-budget reservation.

Proof returns exactly `schema: "worker-cooling-proof-v1"`,
`fan_duty_percent: 100`, `fan_rpm` (integer 1–65535),
`post_command_fan_proven: true`, `asic_effects: false`, and
`budget_reserved: false`. Restoration returns exactly
`schema: "worker-cooling-baseline-v1"`, `fan_duty_percent: 30`,
`cooling_proven: true`, `asic_effects: false`, and `budget_reserved: false`.
Here `budget_reserved: false` means this operation creates no reservation; it
never means the durable campaign ledger is empty or available for reuse.

Firmware journals the temporary fan effect and uses its qualified cooling and
regular SafeStop path to restore the baseline, including on connection loss.
The browser clears cached restoration confirmation before an effect and restores
that flag only after an actual baseline-confirmed status response. Restoration
invalidates possession; budget review or subsequent Start preparation requires a
fresh proof. The outer command bound is the existing 145-second restoration
bound, with independent heartbeats and device deadlines unchanged. Any failed
or malformed response closes the connection and leaves restoration unconfirmed.

The qualification page exposes `proveCoolingForQualification()` and
`restoreCoolingBaseline()`, returning only the closed report and updating public
state. The public codec and `qualificationCoolingRequest` /
`qualificationCoolingResult` schema definitions reject arbitrary actions, fields,
and out-of-range RPM. The generic simulator cannot prove physical fan behavior
and explicitly rejects this command.

`submitCoolingReview()` coordinates the page with the qualification supervisor.
It privately obtains the original campaign and a one-time nonce from
`/cooling-review-context`, obtains fresh possession and the initial budget,
proves the fan, restores the qualified baseline, obtains fresh possession again,
and reads the budget again. A mismatched campaign or pending reservation blocks
the fan effect; any budget change prevents a review receipt. It posts only the
nonce, closed proof/restoration reports, before/after budgets and public state
to `/cooling-review`. Its return contains only the saved-receipt filename and
closed success/equality booleans. Neither campaign identity nor possession
binding enters the posted evidence or return. It clears any cached authorization
context throughout; a later signed window requires its own separate budget review.

## Iterative qualification successor

ADR 0099 introduces the optional signed `qualificationAttempt` Start field,
mutually exclusive with `acceptanceCampaign`. Its exact fields are
`schema: "worker-qualification-attempt-v1"`, `id` (canonical sixteen-byte
base64url), `ordinal` (1–4294967295), `purpose` (`diagnostic`, `normal`,
`foreground_loss`, `heartbeat_loss`) and `maximumActiveMilliseconds` (180000
for normal, 30000 otherwise). Existing Work Lease Authority signatures cover
this object, the entire request and fresh possession. The application manifest
adds `qualificationAttemptProfile: "worker-qualification-attempt-v1"`; its
signed capability digest changes while fixed serial 0.2 framing remains.
Legacy requests retain their original signing semantics and ledger meanings.

`qualification_attempt_review` requires exactly `{}` as payload and fresh
possession with safe idle/no pending effects. Its exact result is
`schema: "worker-qualification-ledger-v1"`, `next_ordinal` (1–4294967296),
`total_charged_ms` (0–9007199254740991), `pending` (boolean) and
`last_completed_ordinal` (u32). Last completed equals next minus one when idle,
or next minus two when one attempt remains pending. Next 4294967296 denotes
exhaustion. Review observes the separate durable ledger and changes no budget.
The original complete 240000-ms campaign remains immutable.

Existing qualification telemetry may include `attempt` with exactly
`schema: "worker-qualification-observation-v1"`, `ordinal`, `purpose`,
`maximum_active_ms`, `reserved_ms`, `complete`, and `active_ms`. The purpose
limits match the grant; reservation and active time are bounded by that limit,
and active time must equal the enclosing generation's active time. This object
contains no ID and does not redefine legacy budget fields. Public signed
cross-language examples live in
`conformance/bwg-worker-controller-0.4/qualification-attempt-vectors.json`.

The actual acceptance page supports all purposes through ordinary Start and
Renew calls. Diagnostic purpose stops promptly on its first observed dispatched
work; normal and fault purposes retain their signed limits and independent
safe-stop requirements. `reviewQualificationAttempts()` obtains fresh possession
before querying the separate ledger. Budget/cooling supervisor contexts may use
`{nonce, mode: "iterative"}` to select this ledger without a campaign ID;
legacy contexts remain unchanged. `submitAttemptCompletion()` reviews both
ledgers after confirmed restoration, closes the serial connection and posts
only closed ledger/public-state observations before returning the bounded result.

## Preparation receipt export

The exact producer prefix is `worker_preparation_receipt schema=v1` followed by
`origin=current_boot|previous_boot` and `status`. Invalid statuses (`incomplete`,
`corrupt`, `unavailable`, `wrong_firmware`) permit only `redacted=true` afterward.
For `status=valid`, fields follow in order: `interrupted=true|false`,
`source_hash` (16 lowercase hex), `boot_ordinal` (u64), `generation` (u32),
`sequence` (u32), `uptime_ms` (u64), `last_completed_step` (0–9),
`current_step` (1–9), `outcome=started|completed|failed`, `failure`, `heap_free`,
`heap_largest`, `stack_free` (u32 or `unavailable`), and `redacted=true`.
Failure is exactly `none`, `cancelled`, `safety_unavailable`, `owner_unavailable`,
`queue_full`, `reply_timeout`, `hardware_write_failed`, `fan_timeout`,
`unsupported_profile`, `asic_failed`, `asic_plan_invalid`, `cooling_timeout`,
or `cooling_proof_required`. Started/completed outcomes require none; failed
requires a non-none category. Started requires last_completed_step < current_step;
completed requires equality; failed permits last_completed_step \<= current_step
to preserve a completed step followed by late cancellation. An interrupted
started record cannot invent a failure.
Interrupted means the retained previous valid slot survived an interrupted
new write; on current_boot it can mean a writer is still in progress and is not
proof of a crash. It never proves the interrupted step completed. Heap fields
measure internal 8-bit memory bytes; stack_free is the pinned Xtensa watermark
in bytes. U64 values remain
exact decimal strings in browser observations.

Previous-boot receipts, panic observations, allocation failures and allocation
contexts have separate bounded retention
that current diagnostics and reconnect resets cannot evict. Explicit
`exportDiagnostics()` posts `{schema: "worker-diagnostic-export-v1", observations: [...]}` to `/diagnostic-export` only after revalidating every
observation against the closed producer grammar. Maximum count is 40. Unknown
fields, altered types, arbitrary strings and raw log material are rejected.
The public validator is `web/worker-diagnostic-export.ts`; it returns only
sanitized closed records. The page returns only a validated opaque receipt filename.

Allocation crash receipts share the eight reserved crash slots, separate from
32 normal diagnostic observations. Their stable keys use category, source hash,
requested size, capabilities and stage when present; absent boot identity is
never invented. Reconnect clears normal observations while preserving these
receipts. Deduplication and saturation retain the 40-observation export bound.

## Owner-resource qualification observations

Qualification telemetry may include `owner_resources` containing exactly
`schema: "worker-owner-resources-v1"`, `generation` (u32, equal to the enclosing
qualification generation), `phase` (`preparation`, `active`, `shutdown_complete`),
`observed_at_ms` (canonical decimal u64 string), `heap_free_bytes`,
`heap_largest_bytes`, and `stack_free_bytes` (u32). Firmware captures these from
the production owner and exposes the coherent object only for the same generation
and an age no greater than 1000 ms. The browser cannot compare a device uptime to
its host clock and does not invent its own freshness calculation. Stack headroom
is the owner task's lifetime high-water observation, not a phase-local minimum.

For a current iterative grant, actual running observations must include an
active-phase owner resource observation with at least 4096 bytes of stack
headroom. Missing or insufficient evidence records `window_control_failed` and
closes/restores the Worker connection. Initial diagnostic work observations are
retained before its immediate safe stop. Legacy campaign behavior is unchanged;
the optional observation does not alter any signing or manifest field.

The public page retains the first resource failure as optional
`ownerResourceFailure: {schema: "worker-owner-resource-failure-v1", generation, resources}`. Generation or resources can be null when missing; otherwise resources
is the already validated closed snapshot. Cleanup/reconnect cannot replace this
snapshot, and a new Start clears it. Version 2 qualification judgments associate
it with the current attempt and preserve it as failed evidence.

Diagnostic ordinal 1 observed only 28 bytes remaining on a 16384-byte owner stack
after one work dispatch and safe stop. That observation does not establish the
prior panic's cause. The firmware-owned next qualification measures a targeted
24576-byte stack against the 4096-byte minimum before a longer run.

## Mining progress observations

Controller status may include the closed optional `qualification.mining_progress`
object defined in [Worker mining progress v1](worker-mining-progress-v1.md) and
`contract.schema.json#/$defs/miningProgress`. It is not part of the signed serial
application manifest and carries no authority. Legacy qualification records may
omit it. In particular, zero `nonce_work_correlations` retains its existing
qualified-candidate-delta meaning and does not prove zero received ASIC nonces.

The current optional mining-progress producer uses [version 2](worker-mining-progress-v2.md)
for fixed-filter match/miss observations; the parser retains historical version 1.

## Signed pool difficulty hint

[ADR 0100](../adr/0100-bind-worker-pool-difficulty-hints.md) adds required manifest
field `poolDifficultyHintProfile: worker-stratum-difficulty-hint-v1` and optional
Start field `stratum.suggestedDifficulty` (integer 0–65535). Absence or zero sends
no Worker hint and never consults NVS. Explicit zero remains present in canonical
signing input. A positive hint does not change the ASIC filter or the pool's
chosen target. Public signed vectors are exported as
`bwg-core/worker-difficulty-hint-conformance/fixtures`.
