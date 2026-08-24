# BWG/0.1 Lifecycle Control

The Gate Authority persists separate Work Challenge and Work Session state machines. `GET /v0/challenges/{challenge_id}/lifecycle` returns a redacted challenge snapshot containing state, Verified Progress, Work Requirement, the absolute challenge expiry, and whether the retained progress can still lead to authorization. It does not expose claimant keys, Work Session identifiers, lease continuity identifiers, or Worker details.

The Relying Service backend forwards claimant Pause and Cancel intent through its existing service credential. `POST /v0/challenges/{challenge_id}/pause` accepts `user_requested`, `tab_closed`, or `connectivity_lost`; each reason ends active leases while leaving an active challenge and its Verified Progress resumable. `POST /v0/challenges/{challenge_id}/cancel` requires `{"confirm_progress_loss":true}` and terminally makes retained progress ineligible. Claimant proofs and challenge identifiers alone never authorize these commands.

The Pool Adapter prepares a session in `ready`, starts or renews one bounded monotonic Work Lease in `leased`, moves an ended lease to `stopping`, and records Worker confirmation as `restored`. A failed session remains `failed`. A session cannot be leased again until restoration is confirmed, and no session can resume a cancelled or expired challenge.

One Work Lease lasts at most 60 seconds and should be renewed every 20 seconds. A renewal retains the lease identity only when its boot-continuity identifier is unchanged, its monotonic reading has not decreased, and the prior monotonic deadline has not arrived. Reboot, monotonic reset, uncertain time, and lease expiry clear the lease and request Mining Baseline restoration.

The lifecycle snapshot also publishes `lifecycle_deadline_unix_seconds`, which is the Work Challenge deadline before issuance and the Gate Pass deadline after issuance. Connected SSE clients receive an `expired` lifecycle event when that deadline arrives.

The BWG/0.1 reference profile uses a 15-minute Work Challenge, a two-minute Gate Pass, a 60-second single-use DPoP freshness window, and zero verifier clock-skew extension. Future-issued DPoP proofs are invalid. The signed or persisted deadline is the first invalid instant.
