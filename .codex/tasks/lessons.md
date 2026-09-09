## lesson-separate-pass-expiry-from-idempotent-outcomes | 2026-08-22 15:00

1. Date: 2026-08-22 15:00 CDT
2. What went wrong: Idempotent Redemption was described in a way that could imply the Claimant retains or reuses a Gate Pass indefinitely after the first accepted Redemption.
3. Preventive rule: Model an expiring, single-use authorization separately from the durable server-side action outcome; burn the pass on the first valid Redemption and let only the Relying Service's outcome and internal retry state survive.
4. Trigger signal to catch it earlier: A token-retry design says the client can keep presenting a consumed or expired pass to drive execution instead of limiting it to retrieval of an already accepted outcome.

## lesson-mainnet-acceptance-needs-guardrails-not-a-stage-gate | 2026-08-22 20:52

1. Date: 2026-08-22 20:52 CDT
2. What went wrong: Mainnet interaction was placed behind deterministic and hardware-regtest stage gates even though the user accepts working directly with mainnet unless a concrete serious risk requires otherwise.
3. Preventive rule: When mainnet use is explicitly authorized, identify and mitigate the exact irreversible boundaries while keeping deterministic tests in parallel; do not convert general caution into an unrequested environment prohibition.
4. Trigger signal to catch it earlier: A proposal delays all mainnet work until later phases without first naming a specific unmitigated mainnet-only risk that makes current bounded work unsafe.

## lesson-verify-real-browser-foreground-loss | 2026-09-08

1. Date: 2026-09-08
1. What went wrong: Debugger focus emulation could keep a qualification page effectively foreground and make a visibility-loss test misleading. [Source](https://github.com/bright-builds-llc/bitaxe-esp-miner/blob/dc68c5ec/docs/parity/evidence/20260908-worker-preparation-live-acceptance.md).
1. Preventive rule: Verify the owned page is visibly foreground before starting, disable debugger focus emulation only for that owned tab, and trigger an actual browser visibility change; never count synthetic events as foreground-loss evidence.
1. Trigger signal to catch it earlier: A hardware test depends on hiding or navigating away from an instrumented browser page.

## lesson-finish-observers-before-fresh-possession | 2026-09-08

1. Date: 2026-09-08
1. What went wrong: Observer setup after grant loading outlasted the sixty-second possession window; early internal state reads also raced unfinished control operations. [Source](https://github.com/bright-builds-llc/bitaxe-esp-miner/blob/dc68c5ec/docs/parity/evidence/20260908-worker-preparation-live-acceptance.md).
1. Preventive rule: Finish observer setup before obtaining fresh possession and signing. Await the published DOM ready state and completion of each control operation before advancing; do not infer readiness from mutable internal state. If admission expires, preserve the rejection and obtain fresh authorization through the validated continuation path.
1. Trigger signal to catch it earlier: Planning or instrumentation remains unfinished after a grant is loaded, or the next command depends on a still-running connection or control call.

## lesson-seal-samples-and-preserve-historical-validation | 2026-09-08

1. Date: 2026-09-08
1. What went wrong: Late closing events appended to a live sample journal after its result hash was recorded, breaking otherwise valid historical evidence. [Source](https://github.com/bright-builds-llc/bitaxe-esp-miner/blob/dc68c5ec/docs/parity/evidence/20260908-worker-preparation-live-acceptance.md).
1. Preventive rule: Seal immutable sample bytes before finalizing a result. Preserve the earliest failure separately from later judgment gaps; accept only exact benign closing copies after sealing and retain conflicting evidence. Revalidate historical results against their sealed inputs and original policy, independently of future checkout state or parser changes.
1. Trigger signal to catch it earlier: A result references a journal that can still receive events, or replay validation consults current live prerequisites instead of the original evidence.
