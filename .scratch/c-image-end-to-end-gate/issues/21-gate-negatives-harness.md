# Gate negatives harness for the C image

Type: task
Status: resolved
Blocked by: None

## Objective

Ticket 08's first part (2026-11-09) ran the interruptions the Gate's deployed
page can drive. The authorization negatives need tooling the page doesn't have.
Build that tooling against the deployed page, without changing production code,
and prove it on the production-path rehearsal. Ticket 28 runs it on the boards.

## Plan

- [x] A CDP harness that drives the deployed page (`reference-account-page`) in
  test Chrome. It intercepts the Authority's
  `/v0/challenges/{id}/work-session/{start,renew}` responses with Fetch, so that it can:
  - withhold a grant;
  - hold a grant until the board's 60 s context has expired;
  - hand one tab's grant to another tab, which in Ticket 28 is another board.
- [x] In each case, mining never starts, the page and Authority end the attempt,
  and no Gate Pass is issued.
- [x] The harness keeps the request bodies it saw, and checks that the only
  value tied to the board that reaches the Authority is
  `control_session_binding_sha256`.
- [x] All three cases pass on the production-path rehearsal (Ticket 06). Its
  fake board (`web/production-path-rehearsal-device.ts`) already checks each
  grant against its own control-session binding. It needs the board's 60 s
  expiry for an unused context added, which is test code only. Output stays
  free of endpoints, keys and pool identities.

## Answer

`scripts/gate-negatives-harness.ts` drives the reference page in any Chrome
started with `--remote-debugging-port`, over raw CDP (`scripts/cdp-connection.ts`).
Each tab pauses the Authority's `work-session/start` and `renew` responses with
Fetch at the response stage. Renewals pass through. Each tab's first Start grant
is altered by the case:

- `withheld`: the response fails with `ConnectionReset`;
- `expired_context`: it's delivered unchanged 65 s after it paused, past the
  board's 60 s unused context;
- `handed_over`: two tabs' grants are swapped once both have paused.

The harness then cancels each attempt through the page's own Cancel and
confirmation, with trusted input. It judges the case (`gate-negatives-cases.ts`)
from:

- the Authority's event stream: no Verified Progress, no `satisfied` or
  `pass_issued`, and `cancelled` last;
- the page's Cancel, which the Authority accepted with a 2xx;
- the page never asking for or redeeming a Gate Pass;
- on the rehearsal only, the fake board and the miner bridge.

`gate-negatives-audit.ts` checks every request the page sent its origin:

- each route's body carries only its listed fields;
- `control_session_binding_sha256` is the only board-derived field, and it is a
  SHA-256 digest;
- no known board value appears in a URL, header (decoded JWS claims too) or body.

Output names cases, route templates and field names, never values, endpoints,
keys or pool identities, and error text is redacted. Nothing in the harness signs.

`scripts/rehearse-production-path.sh --negatives` runs it on the Ticket 06 stack
in headless Chrome. The fake board now refuses a Start whose possession context
is 60 s old with `admission_required`, before it verifies the grant, as the C
board's `prepare_start` does (unit tests in
`web/production-path-rehearsal-device.test.ts`). The passing run on 2026-11-14:

- `withheld`: the board never received `start_lease` and the miner never
  started. The Authority went `active`, then `cancelled` on the page's Cancel,
  and the board confirmed restoration as `cancelled`.
- `expired_context`: the grant was held 65,005 ms. The board received
  `start_lease` and refused it with `admission_required`, and no lease started.
  The page then failed closed and dropped the port (any refused Start does that),
  and its Cancel still ended the Authority's attempt as `cancelled`.
- `handed_over`: the two tabs' bindings differed. Each page refused the other
  tab's grant at its challenge binding, before `start_lease`. Each rolled back
  (`pause` to the Authority) and cancelled, and each board confirmed `cancelled`.
- All three: Verified Progress `0`, no Gate Pass request, and the only
  board-bound field was `control_session_binding_sha256` on `start`.

Ticket 28 runs it against the deployment with `--browser`, `--origin`,
`--payout-address-file` and optionally `--board-values-file`, a person picking
each tab's port. On a real board the harness can't read the board, so its
verdict there rests on the page and the Authority, and the board's log is read
by hand.

Non-claims:

- A handed-over Start grant never reaches the other board through the page. The
  page checks the grant's challenge first, and the two tabs' challenges differ.
  So the board's own "contexts differ" refusal isn't exercised by this case; it
  stays proven by `negative-cases.json`, the C host tests and the fake board's
  unit test.
- Real boards weren't used (Ticket 28).

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
- 2026-11-14, Ticket 21 done: the harness passed all three cases on the
  production-path rehearsal with test keys (the Answer above). Production code is
  unchanged; the fake board gained the 60 s unused-context expiry.
- 2026-11-14, review fixes:
  - A tab passes only if the audit saw its Start carry a binding, so a skipped
    body or a wrong `--origin` can't pass unchecked.
  - A POST to a listed route whose body wasn't captured is a violation.
  - Each tab must receive a `verified_progress` event; the stream's snapshot
    sends one, so progress `0` is observed, not assumed. A `resync_required`
    event fails the case.
  - The audit refuses an empty board-value list, and deployment runs require
    `--board-values-file`. Evidence lists the labels of the values searched.
  - Stream events are read by name before any JSON parse (`resync_required` is
    plain text). Failures in the recorder, including an uncaptured body, become
    case failures rather than unhandled rejections.
  - Every printed line is redacted.
  - After a failed step the harness tries the page's Cancel, so a deployment's
    challenge isn't left to expire.
  - All three cases passed again on the rehearsal, after rebasing onto Tickets 26
    and 27. With Ticket 26, the page now also closes the port after each confirmed
    Cancel (`portClosed: true` next to restoration `cancelled`).
