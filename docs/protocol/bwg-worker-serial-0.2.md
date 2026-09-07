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

| Field | Value |
| --- | --- |
| `hostToDeviceReceiveWindowBytes` | `2048` |
| `maximumHostWriteChunkBytes` | `1024` |
| `recordWriteTimeoutMilliseconds` | `2000` |
| `payloadIntegrity` | `sha256_exact_utf8_json` |

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
32 integrity-valid, well-formed old receive-credit records without applying
their counters or resetting any deadline. To resynchronize after an interrupted
old output record, it may discard one leading malformed UTF-8/JSON protocol
line, at most 66560 bytes and terminated by LF. Valid JSON with wrong profile,
fields or integrity still fails. These bootstrap exceptions end immediately
after Hello validation; ordinary active-session parsing remains strict.

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
