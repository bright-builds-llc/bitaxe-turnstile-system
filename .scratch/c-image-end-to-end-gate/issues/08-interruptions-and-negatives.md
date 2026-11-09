# Interruptions and negatives on the C image

Type: task
Status: ready-for-human
Blocked by: 07, 17

## Objective

Repeat the failure cases of criterion 11 and Core Ticket 23's open items through
the production path on the C image, each ending challenge mining and confirming
restoration.

## Plan

- [x] Pause, terminal Cancel, expiry, disconnect, tab close and reboot.
- [ ] Withheld, expired-context and cross-possession authorizations fail before
  mining, and only the control-session digest reaches the Authority (moved to 21).
- [ ] The same possession request answered by the other board derives a different
  context and can't reuse the first board's authorization (moved to 21).
- [ ] Pool failure, adapter replay and stale-job cases. Pool failure passed;
  adapter replay and a stale job moved to 21.
- [ ] A fresh admission after abrupt loss reports a positive
  `helloRecovery.discardedReplies`, which no firmware has shown yet
  (moved from `bwg-worker-serial` Ticket 15, then to 21).

## Comments

- 2026-11-09: the Ultra 205 ran the interruptions through the deployed page, on
  the owner's reference image of the C firmware `247d2cd`, at 2^45, with an
  agent clicking the page's controls on the owner's authorization. Each case
  ended mining with the board's `Lease stop finished ok=1`, in about 19 to 20 s,
  and only completion issued a Gate Pass. On `8844302`:
  - completion, minimized, renewed once from the page and redeemed;
  - Cancel left the challenge `cancelled`; the page kept the port afterwards;
  - a closed tab stopped the board by `heartbeat_timeout` 2,800 ms after the
    last heartbeat;
  - USB dropped while powered stopped it by `link_closed` after 2,510 ms;
  - a stopped pool ended the session as `transport_disconnected` about 2 s after
    the adapter lost it, and the board stopped with `control_failed`;
  - pulled power brought the board back paused from a power-on reset.
- 2026-11-09: Pause failed three times on `8844302`, which became Ticket 20.
  With its fix (`eb475f9`), Pause offered as soon as the Start finished stopped
  the board with `restoration_requested`; after Resume the page renewed twice
  and the run completed and redeemed. A Pause left alone sent no renewal, and
  the challenge expired after 15 min with no Gate Pass; the page showed it
  expired but kept the port.
- No stale job was seen, since no new tip came during a lease. The negatives,
  adapter replay and `discardedReplies` need tooling the page lacks and go to
  Ticket 21. The fork's record is "Ticket 08 on the 205" in its
  `docs/project/gate-integration-evidence.md`.
