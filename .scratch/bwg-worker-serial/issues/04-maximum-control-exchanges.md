# 04: Preserve liveness during maximum control exchanges

**Status:** resolved
**Blocked by:** None

- [x] Exercise both exact 65536-byte Controller payload directions in the qualification probe.
- [x] Preserve authenticated heartbeat headroom around long indivisible records without extending leases or deadlines.
- [x] Accept the added closed Wi-Fi allocation checkpoints and transport timing failures.
- [x] Run all required checks and prepare the verified revision for publication and exact consumer pinning.

## Context

The physical16c firmware admitted possession and a no-mining baseline, then the maximum-size probe lost peer liveness. The existing echo probe also makes only the larger request envelope exactly65536 bytes, while cycle admission requires both directions at that bound. Correct the probe contract and test actual transfer timing, preserving the failed hardware attempt and all revocation limits.

## Review

The probe now independently fills request and response Controller envelopes to 65536 bytes with validated fixed-pattern padding. Its public method remains unchanged; the paired firmware consumes the explicit responsePaddingBytes field. A fresh authenticated heartbeat precedes the maximum probe, and the stream write uses a bounded two-second allowance while the authority cutoff remains 2.8 seconds. Closed diagnostic parsing accepts the new Wi-Fi construction checkpoints and queued-byte transfer failure metadata without exposing record contents.

The prior maximum-response assertion failed before correction; both exact-bound assertions now pass. Full `bun run format` and `CARGO_BUILD_JOBS=1 RUST_TEST_THREADS=1 bun run verify` pass, including 295 existing plus one new web/CLI test, Rust/type/build/browser/package/standards checks. Hardware probe resolution and qualification remain in the firmware task.
