# ADR-0098: Prove cooling before the final Worker window

Accepted 2026-09-07 under the owner's authorization to complete diagnosis,
recovery qualification and the subsequent bounded live tests. This refines
ADR-0097 without increasing the original 240000-ms campaign ceiling.

## Evidence and correction

Attempt-011 completed four exact-image cycles and the invalid-signature
rejection/reconnection check with an unchanged ledger. Original window 1 then
failed before hardware preparation: readiness mask 55, fresh fan RPM zero,
zero work dispatched and zero active milliseconds. Recovery and a fresh ledger
review confirmed masks 3, charge 210000 ms and no pending reservation. Its
original failure remains immutable. Window 0 also remains consumed/unverified.

The prior readiness predicate required a running fan before preparation could
command full fan. Fresh safe zero-RPM observations may now admit only the
never-prepared Worker candidate's fan preparation. Ordinary and running-state
requirements remain unchanged. Applied full-fan acknowledgement, followed by a
same-boot advancing nonzero RPM sample acquired after that acknowledgement,
remains mandatory before voltage, ASIC enable or work. Cancellation, stale or
zero feedback never permits those effects.

A qualification-only Controller 0.4 cooling operation uses the existing sole
production/safety owners and cannot issue ASIC, frequency, voltage or pool
commands. Fresh possession and an idle mining owner are required. Full-fan
qualification creates no mining reservation. Its effects are journaled and
retain generation ownership until restored; queued fan lowering rechecks the
owned generation and fresh temperature at or below 45 C. Failure retains full
fan and cleanup ownership. No safety threshold is weakened.

## Last-window successor

Before issuing the final lease, require the new clean image's four continuity
cycles, an actual fan-only proof, acknowledged baseline restoration and equal
possession-bound ledger reports before/after that operation. The protected
cooling receipt is bound into the new successor and checked at issuance.

A version-2 successor may select only original window 2 when the fresh ledger
matches the original campaign, masks 3, charge 210000 ms and no pending cleanup.
It binds attempt-011's failure, zero-work recovery and ledger evidence, plus
its immutable ancestry back to attempt-010. It cannot invent successful results
for windows 0 or 1, use a prior issuance of window 2, refund reservations, mint a
campaign or increase the limit.

Within the final 30000-ms reservation, observe real work and a signed renewal
if possible, then suppress application heartbeats with more than 3000 ms of
fresh device work-gate headroom. Keep the 5000-ms renewal interval and 15550-ms
shutdown reserve. The device must close admission and initiate shutdown within
three seconds; ordered shutdown and bounded cooling remain separate required
postconditions. Actual ASIC work, renewal, share and timing are claimed only
when observed. The separate original normal and foreground-loss criteria stay
unverified; no automatic parity promotion follows this last-window test.

If cooling cannot be proved, do not issue the last lease. If the final window
fails or produces no accepted share, retain that result without extending the
campaign. Finish with the new firmware installed, mining disabled, fan safely
restored, volatile inputs cleared and all resources released.
