# ADR-0114: The page shows a standard Worker its lease's Stratum settings

Proposed 2026-11-26 by the agent, as a default under the owner's standing instruction for software-only work, for Core MVP criterion 2 and bwg-core Ticket 25. The owner may amend it. It changes no public route, Controller, deployment-trust or Gate Pass profile.

## Decision

A deployment may offer "Use another Stratum V1 Worker" beside "Connect Bitaxe over USB" by naming a `maybeStandardWorker` disclosure in its page config. Without one, the page offers the Bitaxe only, so the owner's deployment is unchanged until its config says otherwise.

On that choice, the page:

- runs the headless client with no Worker Controller;
- names the lease's control session by the SHA-256 of a secret that stays in the page;
- shows the endpoint, username and password of each started or resumed lease;
- renews the Authority's lease while work runs, keeping the same password, as Renew always does (ADR-0106).

The settings are withdrawn before a Pause or Cancel reaches the Authority, and when the Authority reports the challenge satisfied, issued, cancelled or expired.

The page can't stop a Worker it doesn't control. The Pool Adapter ends gated work instead: once the lease ends, its credentials stop authorizing, and its connection ends at the credential's expiry, at most 60 seconds later. Shares in that window are forwarded to the pool but earn no credit. The page then asks the claimant to point their Worker back at its usual pool. Mining Baseline restoration is the claimant's for a standard Worker; it isn't a confirmed device state.

## Why

Criterion 2 lets a claimant use any standard Stratum V1 Worker, and user story 23 asks for short-lived settings rather than custom firmware. The Authority already issues plain Stratum credentials in every lease grant. The only missing piece was a page that hands them to a person instead of a board.

## Consequences

- The password appears on the claimant's screen. It authorizes only that Work Session, for at most 60 seconds past its last renewal, and pays any reward to the claimant's own payout choice.
- After the Work Requirement, a standard Worker keeps mining for up to that window. A Bitaxe stops at once and confirms restoration. In the regtest rehearsal the window was 56 s, and the 110 shares in it were refused as `challenge_satisfied`.
- The consent disclosure names the configured standard Worker and its stated hashrate, since no signed capability describes it.
