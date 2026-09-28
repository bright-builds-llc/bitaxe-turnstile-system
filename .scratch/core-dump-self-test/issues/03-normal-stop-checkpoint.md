# task-normal-stop-checkpoint | 2026-09-28 | Preserve normal work authorization

Status: resolved
Blocked by: None

The normal V2 Start/Stop path must retain the actual private post-authorization
high-water observation for comparison after a fresh connection. The original
pre-work baseline must remain unchanged. No hardware occurs in this task.

- [x] Reproduce the missing checkpoint through the real page/controller path.
- [x] Capture normal-stop evidence from authenticated private observations,
  retaining the known Start/Renew boundary and rejecting stale or changed state.
- [x] Test reconnect match, missing evidence, generation mismatch and unexpected
  high-water changes without resetting the original preservation baseline.
- [x] Run Gate verification and report the interface. Do not publish yet.

## Answer

The RED real-page/serial-controller regression failed at normal Stop because
`authorizationRecovery` was absent. The corrected path uses the existing
checkpoint and private callbacks, with one operation wrapper around successful
V2 Start/Renew responses. Stop sends Restore first, then compares its fresh reply
against the known authorization observation. No extra request delays Stop.

The original baseline remains unchanged. A fresh matching connection sets the
same checkpoint to matched; read/ledger/idempotent Stop/Close preserve its ID.
Missing private fields, stale callbacks, changed generation and unexpected
high-water advancement fail closed, including rollback after a mismatch. Idle
before/restart pages create no checkpoint. Existing heartbeat-fault checkpoints
and their retained reasons survive the recovery flow.

Verification: 22 focused tests, including 11 real page/controller scenarios,
passed. `bun run verify` passed Rust checks, 840 web/conformance tests, browser
conformance, build, package and standards checks. Final typecheck, Markdown and
diff checks passed. No wire changes, device access or hardware claim occurred.
Negative cases also verify that Stop already reports not running after restored
device state, and that final Close clears the loaded window. The coordinating
task approved publication after independent review.
