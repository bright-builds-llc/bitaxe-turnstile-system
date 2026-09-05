# ADR-0095: Use four fixed-USB qualification cycles

Accepted 2026-09-05 by explicit owner request. Amends the hardware qualification sample for ADR-0094's fixed Serial/JTAG/Web Serial design.

Require four complete no-mining connect/release/flash/reconnect cycles before bounded live acceptance. Preserve completed valid cycles on the exact firmware and browser artifacts, with the same private preservation baseline and fresh possession after every reconnect. Four cycles provide less repeated exposure than twenty; the owner accepts that tradeoff.

Keep the 240-second device-enforced cumulative mining ceiling, 180/30/30-second windows, foreground/liveness requirements, cryptographic identity and lease authorization, replay marks, privacy, shutdown and cooling requirements unchanged.

The deployed Gate browser revision remains bound to its qualified artifact. A separate documentation/qualification revision may record the reduced sample through a sealed amendment that preserves the original context, campaign and cycle digests. The firmware-side supervisor verifies exact artifact hashes and reviewed source-path allowlists. It must establish a fresh authorization scope after restart without silently resetting page continuity.

Closed issue records and earlier work plans remain historical. This change grants no legacy WebUSB compatibility, firmware replacement, extra mining budget or parity promotion.
