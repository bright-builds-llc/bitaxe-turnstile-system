# Gate negatives harness for the C image

Type: task
Status: ready-for-agent
Blocked by: None

## Objective

Ticket 08's first part (2026-11-09) ran the interruptions the Gate's deployed
page can drive. The authorization negatives need tooling the page doesn't have.
Build that tooling against the deployed page, without changing production code,
and prove it on the production-path rehearsal. Ticket 28 runs it on the boards.

## Plan

- [ ] A CDP harness that drives the deployed page (`reference-account-page`) in
  test Chrome. It intercepts the Authority's
  `/v0/challenges/{id}/work-session/{start,renew}` responses with Fetch, so that it can:
  - withhold a grant;
  - hold a grant until the board's 60 s context has expired;
  - hand one tab's grant to another tab, which in Ticket 28 is another board.
- [ ] In each case, mining never starts, the page and Authority end the attempt,
  and no Gate Pass is issued.
- [ ] The harness keeps the request bodies it saw, and checks that the only
  value tied to the board that reaches the Authority is
  `control_session_binding_sha256`.
- [ ] All three cases pass on the production-path rehearsal (Ticket 06). Its
  fake board (`web/production-path-rehearsal-device.ts`) already checks each
  grant against its own control-session binding. It needs the board's 60 s
  expiry for an unused context added, which is test code only. Output stays
  free of endpoints, keys and pool identities.

## Comments

- 2026-11-14, triage with the owner:
  - The negatives use CDP interception on the deployed page. The Authority signs
    every grant through the launcher, so the dev lease authority stays in the
    launcher only, and no agent tool signs with it.
  - Web Serial can't be intercepted. So "the same possession request answered
    by the other board" is proven on hardware as one board's grant handed to the
    other. Same nonce with a different identity stays proven by
    `negative-cases.json` and the C host tests (`test_lease_auth.c`).
  - The other items this ticket held moved:
    - the port after Cancel or expiry (closed, as completion does) to Ticket 26;
    - adapter replay to a Rust test in Ticket 27;
    - the board runs, the acceptance-page `discardedReplies` check and the
      stale-job watch to Ticket 28.
