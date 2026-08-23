# V1 Lifecycle

## Work Challenge

| State | Meaning | Allowed next states |
| --- | --- | --- |
| `issued` | Immutable Action Policy revision, Action Reference, Claimant key, Work Requirement, and Pool Offers exist; work has not begun. | `active`, `cancelled`, `expired` |
| `active` | Work Consent has been recorded and zero or more Work Sessions may contribute. Pausing removes leases without changing this state. | `satisfied`, `cancelled`, `expired` |
| `satisfied` | Verified Progress reached the Work Requirement; further results do not change gate authorization and pass issuance is durably pending. | `pass_issued` |
| `pass_issued` | A short-lived proof-of-possession Gate Pass is available and every Work Lease is ending or restored. | `expired` |
| `cancelled` | The Claimant explicitly abandoned the challenge; sessions are revoked and partial progress cannot resume. | None |
| `expired` | The challenge or unredeemed pass reached its absolute deadline. | None |

Gate Pass Redemption is intentionally not a Gate Authority state. A Relying Service verifies and atomically consumes the signed pass independently, then creates its own Redemption Record.

## Work Session

| State | Meaning |
| --- | --- |
| `ready` | Challenge-scoped credentials exist but no Worker currently holds a lease. |
| `leased` | One Worker has a valid monotonic Work Lease and may mine. |
| `stopping` | Cancellation, expiry, completion, or lost continuity has requested safe stop. |
| `restored` | The Worker confirmed its Mining Baseline. |
| `failed` | The session cannot continue safely; the challenge may use another session while still active. |

Lease expiry, lost connectivity, or tab closure pauses contribution and preserves challenge progress. Explicit cancellation is terminal. Accepted Work Events received after challenge expiry do not count, although the Mining Pool still handles any block candidate through its independent path.

## Redemption

1. The Claimant presents an unexpired Gate Pass and fresh DPoP proof for the exact Action Reference.
2. The Relying Service atomically burns the unique pass identifier and creates a Redemption Record.
3. The Relying Service executes or internally retries the Protected Action idempotently.
4. Bounded claimant-key-authenticated status lookup may retrieve the accepted outcome but cannot reauthorize or restart the action.
