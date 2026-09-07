# ADR-0099: Bind iterative qualification and preserve crash evidence

Accepted for the owner-approved iterative diagnosis and live qualification.
This supersedes ADRs 0097–0098 only where they restrict further qualification to
unspent windows of the original campaign. Original reservations, failed evidence
and the original 240000-ms ledger remain immutable and are never refunded.

## Decision

Controller 0.4 Start may carry either legacy `acceptanceCampaign` or the new
`qualificationAttempt`, never both. The new object contains exactly
`schema: worker-qualification-attempt-v1`, a canonical sixteen-byte base64url `id`,
`ordinal` (1 through u32 maximum), `purpose` (diagnostic, normal, foreground_loss,
heartbeat_loss), and `maximumActiveMilliseconds`. Normal is bounded at 180000 ms;
each other purpose is bounded at 30000 ms. Existing Work Lease Authority signs
this entire request through the existing request digest, fresh possession binding,
and durable authorization sequence. No new role, unsigned bypass or helper
transport is introduced.

The firmware enforces a distinct durable attempt ledger: strict next ordinal,
no reuse, no refund, and cumulative charged milliseconds. New attempt admission
requires the original campaign ledger to remain complete at 240000 ms. Legacy
status budget fields keep their original meanings. Optional attempt telemetry
contains only ordinal, purpose, its maximum/reservation, completion and active
time; active time equals the enclosing generation's active time. It does not
expose the opaque attempt ID or imply authority to start again.

`qualification_attempt_review` has an empty payload and requires fresh possession
and a safe idle device. It returns closed next ordinal, last completed ordinal,
pending state and cumulative charge. Next ordinal 4294967296 represents exhaustion
and cannot appear in a new grant. Review never mutates either ledger.

The fixed serial 0.2 application manifest gains
`qualificationAttemptProfile: worker-qualification-attempt-v1`. Capability signing
and possession bind the changed manifest digest and exact firmware identity.
The Controller, framing, role separation, foreground heartbeat deadline, safe
stop, state-preserving update and cooling requirements remain unchanged.

Diagnostic purpose stops promptly after initial work is observed; normal purpose
seeks actual correlated work/share evidence within its signed bound. Foreground
and heartbeat-loss purposes remain separate bounded fault checks. Every retry
requires verified progress and a newly signed ordinal; changing an ordinal alone
is not progress.

## Preparation and panic evidence

Firmware publishes closed preparation receipts with explicit current_boot or
previous_boot origin, integrity status and source/boot association. Valid records
contain only step/counter/outcome and bounded resource observations. Invalid
integrity states carry no inferred payload. U64 counters remain exact decimal
strings in browser diagnostics. Previous-boot receipts and panic observations are
retained separately so current diagnostic churn and reconnection cannot evict them.

Diagnostic export is explicit and revalidates every observation against closed
producer grammars before the persistence boundary. Export contains no raw logs,
operational pool data, credentials, signing payloads, attempt IDs or possession
bindings. Crash evidence establishes what was observed, never that an unfinished
step completed or the device is safe.

## Verification and rollout

Cross-language signed fixtures cover all purposes and metadata tampering. Parsers
reject dual modes, noncanonical IDs, exhausted ordinals, wrong purpose limits,
unknown fields and inconsistent telemetry. Tests exercise the real browser adapter,
legacy behavior, diagnostic retention/export and fault-purpose mapping. Coordinate
Gate publication, exact archive pin, firmware manifest/capability signing and clean
packaging before any hardware effect. Physical success and safety timing remain
firmware-owned evidence obligations.
