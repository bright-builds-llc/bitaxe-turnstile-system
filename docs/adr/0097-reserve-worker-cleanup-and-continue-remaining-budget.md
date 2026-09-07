# ADR-0097: Fence Worker reservation cleanup and qualify remaining windows

Accepted 2026-09-06 under the owner's authorization to complete admission
recovery, diagnostics and the subsequent live testing. This refines ADR-0094
and preserves ADR-0095's four cycles and ADR-0096's serial 0.2 transport.

## Decision

Reservation is distinct from an idle link and from hardware activation. An
atomic reservation state retains generation ownership before any NVS write.
Revocation closes work immediately but cannot release that ownership until
in-flight storage settles, the mining owner confirms no surviving effects,
and durable finalization succeeds. Competing finalizers must claim retirement
before touching shared generation counters. Ambiguous writes retain the full
intended charge; cleanup never refunds an original reservation.

A bounded Controller 0.4 `acceptance_budget_review` command requires fresh
possession, exact firmware identity and no active lease or pending restoration.
It reads the original campaign's ledger without changing it and returns only
campaign-match, reserved/completed masks, charged milliseconds and pending
state. The identifier is input only. Periodic closed admission diagnostics
remain nonauthoritative, low priority and independent of blocked control/NVS.
Correlated controller errors contain only the existing closed error categories;
malformed requests cannot gain a response containing their input.

## Qualification and remaining budget

The original failed normal window and its consumed delivery remain immutable
and unverified. A successful software correction does not refund its time or
mint another campaign. Before live effects, qualify the exact new clean image
through four no-mining update cycles and fresh browser identity/preservation.
A deliberately invalid-signature Start may test rejection and reconnection
only after real verification regressions prove that it cannot reach budget
admission. Compare read-only budget evidence before and after; never spend a
valid remaining lease on a no-mining rejection test.

If fresh possession-bound ledger evidence confirms original window 0 reserved
and completed, windows 1 and 2 unused, charge 180000 ms and no pending cleanup,
a new immutable successor may admit only those two original 30000-ms windows.
It binds predecessor failure/consumption/context hashes, current source/ELF,
four current-image cycles and reviewed ledger state. No successful window-0
result is synthesized, and the old amendment policy is not weakened.

Window 1 observes foreground work and a signed renewal before foreground loss.
Window 2 observes work before suppressing application heartbeats. Both keep
the original conservative profile, safety observations, lease authorization,
three-second revocation/initiation requirement, ordered shutdown and cooling.
The 15550-ms shutdown reserve leaves 14450 ms of work-gate time per window.
Use a signed 5000-ms renewal interval, keep the signed lease duration unchanged,
and inject a fault only with more than 3000 ms of fresh device headroom;
prefer at least 6000 ms. Stop and retain missing evidence if that window closes.

Each issuance requires a fresh, single-use review tied to the same possession.
After each window, require confirmed restoration, cleanup and durable review
before the next. Any other ledger state fails closed rather than selecting an
unreviewed budget policy. The cumulative 240000-ms ceiling remains unchanged.

## Claims and consequences

Work, renewal, accepted-share and each fault-stop criterion may be verified
only when actually observed. Window 1's foreground prefix may supply those
observations but does not relabel the failed original normal run. Missing
share or timing evidence within the remaining allowance stays unverified.
This allows useful live qualification without concealing failure or increasing
risk. Finish with the new image installed, mining disabled and resources
released. No automatic mining, Stratum or unrelated parity promotion follows.
