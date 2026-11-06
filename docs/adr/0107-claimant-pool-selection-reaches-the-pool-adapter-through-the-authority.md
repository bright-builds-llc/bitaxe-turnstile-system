# ADR-0107: Claimant Pool Selection reaches the Pool Adapter through the Authority

Accepted 2026-11-05, on the owner's choices for `c-image-end-to-end-gate` Ticket 10.
It amends ADR-0106, which kept Pool Selection off the Authority. It changes no
Controller, deployment-trust or Gate Pass profile.

The claimant selects a pool with `POST
/v0/challenges/{challenge_id}/work-session/pool-selection`, authenticated by the same
body-bound `bwg-work-session-proof+jwt` as the other ADR-0106 routes. The body names
the approved Pool Offer and the raw payout choice, and this request is the
claimant's consent to it. The Authority checks the offer against the challenge's
signed set, records the proposal as a commitment, hands the raw choice to the
in-process Pool Adapter port, and only then confirms the commitment. A replay of
the same choice succeeds, and a different choice after consent is refused. The
answer carries the offer ID and the commitment, never the payout destination.

The Authority never persists or logs the raw selection or payout destination, only
the commitment, as Core MVP criterion 13 requires. A test scans every Authority
table and the log output for the raw destination. A second origin and a
Pool Adapter-side claimant-key read were the alternative, and the owner declined
them.

The Pool Adapter stores the raw Pool-facing payout identity in its own session
registry, so it survives restarts and reconnects. This replaces the earlier rule
that the adapter persisted no payout address. The row is deleted when the
challenge reaches a terminal state: satisfied, cancelled by either route, or
expired. A lookup after expiry also deletes it, and an expiry sweep removes any
row left behind. With per-session upstream authorization enabled, the TCP proxy
derives each connection's Pool-facing identity from that row and refuses a session
that has none.
