# 02: Prove preservation without publishing stable Worker fingerprints

**Status:** resolved
**Blocked by:** None

The owner requires twenty fixed-USB release/flash/reconnect cycles to preserve the admitted Device Identity, authorization high-water marks, and nonsecret settings. Raw preservation digests remain in private browser memory. The public qualification state exposes comparison booleans plus one unpredictable per-page baseline ID; resetting the page changes the ID and cannot silently reset campaign continuity.

- [x] Strictly parse the independent `worker-preservation-v1` device status and bind its Device Identity digest to the verified possession key.
- [x] Keep first preservation values in a private closure; publish only `worker-preservation-continuity-v1` booleans and a random baseline ID.
- [x] Carry the closed winning `revocation_reason` in qualification status.
- [x] Test altered identity/settings/replay state, public-state privacy, page reset, and production adapter integration.
- [x] Verify, commit, and provide the new exact Gate consumer pin before hardware effects.

## Completion review

Private preservation is strictly parsed and its Device Identity digest is checked against the verified possession key. The production adapter strips stable digests from public status; the acceptance page keeps its baseline and challenge continuity only in RAM and publishes comparison booleans with one random per-page baseline ID.

Qualification now carries the first winning revocation reason and explicit active-limit, shutdown-tail, and work-gate headroom fields. Normal automatic restoration follows fresh device headroom, not browser start timing. Planned fault arming requires fresh headroom above three seconds. Acceptance windows request terminal cancelled restoration, preserve the 120-second cooling policy with a 145-second outer response deadline, and count only successful signed renewal acknowledgments. Public device-restoration/lease-inactive booleans are based on actual status acknowledgments and invalidated before effects or ownership loss.

Verification passed: Rust format, strict Clippy, all-target/all-feature build and tests; strict TypeScript; 280 web/CLI tests; browser conformance; package dry run; managed standards; and diff review. Regressions cover private-state privacy, identity mismatch, settings/high-water drift, page reset, RAM-only operation, fault headroom, acknowledged renewal counts, and a successful response after 130 virtual seconds within the 145-second outer bound.

No hardware effects were performed. Physical timing, twenty-cycle preservation, accepted mining work, and final hardware restoration remain the firmware task's exact-package qualification obligations.
