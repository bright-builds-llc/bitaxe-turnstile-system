# ADR-0103: The lease budget is mining time, and grants carry no hardware profile

Accepted 2026-10-16, in lockstep with firmware ADR-0037
(`bitaxe-esp-miner/docs/adr/0037-device-configuration-owns-the-hardware-profile.md`,
decisions 1 and 5 as amended). It replaces the Gate's implementation of
firmware ADR-0033's signed `hardwareProfile` and its v1 soak budget.
Controller 0.4, Serial 0.2 and Possession 0.2 are otherwise unchanged.

## Context

- **Profile.** A Work Lease grant could carry `hardwareProfile`
  (`conservative` or `upstream-default`), and `upstream-default` required a
  soak allowance. Firmware ADR-0037 makes the device's saved settings the
  hardware profile. A lease authorizes how much work, never how it is done.
  The firmware now refuses any grant that carries the field.
- **Budget.** A budget used to contain the ordered shutdown tail: 15,550 ms
  for Conservative windows and 19,050 ms for a soak, so a soak was
  619,050 ms. The firmware now closes the work gate at the budget and runs the
  ordered shutdown after it. That shutdown is bounded at 22,550 ms, the closed
  pre-reset tail at the 575 MHz catalog maximum, and status reports it as
  `shutdown_budget_ms`.

## Decision

1. **No `hardwareProfile`.** The grant parser and the signer refuse any grant
   that carries it, as an unknown field. The soak rule that `upstream-default`
   needs a soak, and that a soak states a profile, is gone. A soak is still a
   60,000 ms lease with a 20,000 ms renewal on Stratum V1.
2. **Soak allowance v2.** The allowance schema is `worker-soak-allowance-v2`,
   and `maximumActiveMilliseconds` is exactly 600,000. The ledger review is
   `worker-soak-ledger-v2`, which starts fresh at ordinal 1 with nothing
   charged, and charges exactly 600,000 ms per ordinal. v1 allowances and v1
   ledgers are refused. The live status observation keeps the firmware's
   `worker-soak-observation-v1` name, with a 600,000 ms limit.
3. **Budgets are mining time.** Qualification and acceptance charges
   (30,000 and 180,000 ms) keep their values but now mean mining time.
4. **Restoration deadlines add the shutdown bound.**
   `WORKER_SHUTDOWN_BOUND_MILLISECONDS` (22,550, in
   `web/worker-restoration-bound.ts`) replaces the tails the budget used to
   contain. Existing cooling allowances stay.
   - **Graceful Pause, Cancel, Restore and cooling commands.** They wait for
     3,000 ms initiation, plus the 22,550 ms bound, plus 120,000 ms cooling,
     plus the unchanged 6,450 ms transport allowance: 152,000 ms. It was
     145,000 ms for a 138,550 ms sequence.
   - **Soak browser backstop.** It allows 120,000 ms of preparation, plus the
     600,000 ms budget, plus the 22,550 ms bound, plus the 150,000 ms safe-stop
     allowance: 892,550 ms. It was 889,050 ms.
   - **Browser stops for acceptance windows.** They still request terminal
     Restore at the budget, or with 2,000 ms of work-gate headroom. That stop
     now comes just before the device's own gate close, rather than after an
     in-budget shutdown.

## Consequences

- The soak vectors (`conformance/bwg-worker-controller-0.4/soak-allowance-vectors.json`)
  are regenerated with the public RFC 8032 key as two v2 grants, ordinals 1 and
  2, without `hardwareProfile`. The firmware copy must be refreshed from them.
- ADR-0097's "14450 ms of work-gate time per window" and its 15,550 ms
  shutdown reserve describe the earlier firmware. A 30,000 ms window now mines
  for up to 30,000 ms.
- A Gate built from this change cannot drive firmware that still requires
  `hardwareProfile`, v1 soak allowances or v1 soak ledgers. The two repositories
  must move together.
