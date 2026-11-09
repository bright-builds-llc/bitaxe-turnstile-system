# Pause overlapping a Renew or an in-flight Start

Type: bug
Status: resolved
Blocked by: None

## Objective

Ticket 08's sitting found two page/client defects on 2026-11-09. They were found on the Ultra 205,
running the owner's reference image of the C firmware `247d2cd`, with the Gate at `main` `8844302`.
In both, the board stopped safely.

1. **A Pause overlapping a Renew tick ended Renew, so the resumed lease expired.** `pause()` set
   `paused` only after the board's stop completed, which takes about 20 s on the 205 and 48 s on the
   601. Until then the lifecycle still read `running`. So `renewWorkerLeaseWhileRunning` sent a Renew
   into the stopping session. The Renew was refused, and Ticket 17's "stop on any refusal" ended
   Renew for the session. Nothing renewed the lease after Resume (sequence 13027). The board revoked
   it with `lease_expired` 60 s later. The Authority session ended
   `stopping/transport_disconnected`, while the page still showed "Bitcoin work is running". The
   page before Ticket 17 (`e86b3db`, `scheduleRenew`) kept renewing after a failure.
2. **Pause was accepted while Start was still in flight.** The button read "Pause work" 0.3 s after
   "Consent and start work". The Pause failed with `Worker Serial operation_active`, and the client
   rolled back (board revocation `control_failed`). The page still showed "Bitcoin work is running"
   with a Pause button. The Authority session stayed `stopping/user_requested`, with the challenge
   `active` and progress 0.

## Plan

- [x] Regression tests that fail before the fix: a Renew tick during a slow Pause, then Resume;
  Pause during an in-flight Start; failed Start and refused Renew leave the work paused.
- [x] No Renew or Pause reaches the board while another command is in flight; renewals continue
  after Resume.
- [x] After a failed control command, the page stops claiming that work is running.

## Answer

Root causes:

1. The client had no state for a Pause in flight. The renewal loop read `running` for the whole
   stop. It then treated the resulting local refusal as final, although nothing about the session
   had ended.
2. The Authority reports `active` once its Start returns, before the board's Start completes. The
   client mapped that report straight to `running`, so the view offered Pause and the client
   accepted it. After any failed control command, the client also left `running` in place.

Fix, in `web/headless-client.ts`, `web/worker-lease-renewal.ts` and `web/work-gate-view-model.ts`:

- The client sets `starting`, `pausing` or `resuming` before the command is sent. It refuses every
  other control command while that state holds, without reaching the Controller. An Authority
  `active` during Start keeps `starting`. The view model offers no control and hides Cancel in
  these states.
- Pause and Cancel wait for a Renew already in flight to settle before they send their stop. A
  renewal the Authority answers after Pause began is not forwarded to the board, and is not rolled
  back.
- A failed Start (after the Authority started), Pause, Resume or Renew-with-rollback leaves the work
  `paused`. Each of those paths has already asked the Authority to pause, so Resume is the
  recovery.
- Renew reports a refusal and keeps ticking. It renews only while `running`, so it skips the paused
  session and renews the lease the next Resume obtains. It still stops for good on
  `terminal_reported` or a terminal lifecycle. The rule from `657ac9c`, that no command follows
  terminal restoration, holds. So does the rule that no second Renew is sent while one is in flight.

Board-side `lease_expired` without a client-side failure: the next Renew is refused, the client
rolls back to `paused`, and the page stops claiming running within one Renew period (20 s).

Tests: `web/headless-control-overlap.test.ts` (all six failed before the fix), plus updated
`worker-lease-renewal.test.ts` and `work-gate-view-model.test.ts`. Checks: `bun run typecheck`,
`bun run test:webcrypto`, `bun run test:browser`, `bun run check:standards` and
`bash scripts/rehearse-production-path.sh`.

Non-claims: one board, one run of each case below. `close()` during a transitional state sends no `tab_closed` restoration. The board stops on its
heartbeat deadline once the page is gone, as for a lost cable.

## Comments

- 2026-11-09: rerun on the Ultra 205 through the deployed page at `eb475f9`, on the owner's
  reference image of `247d2cd`. The page hid its control while Start was in flight and offered
  Pause 11.2 s after the click. That Pause stopped the board with `restoration_requested` and
  `ok=1`, and the page showed the work paused. After Resume the page renewed twice, and the run
  completed and redeemed. A second Pause, 0.1 s after the board reported mining and then left
  alone, sent no renewal; the challenge expired after 15 min with no Gate Pass, and the page
  showed it expired. Landed on `main` on the owner's word.
