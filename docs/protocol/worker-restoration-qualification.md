# Worker restoration qualification (BWG-007 serial successor)

The private restoration page is a separate local qualification page for the
firmware task `task-bwg007-real-worker-restoration` (firmware ADR-0035). It runs
eight host-driven scenarios over the existing Worker Serial 0.2 and Controller
0.4 session: `completion`, `pause`, `cancel`, `expiry`,
`monotonic_uncertainty`, `disconnect`, `reboot` and `authorization_negatives`.
The page and its controller hook grant no mining, flashing, budget or
actuation authority. The firmware task contract owns every effect, the
physical checkpoints and the judgement.

## Opt-in and mode exclusivity

The page loads only a public configuration with `restorationQualification:
true` beside the four ordinary keys (`expectedGateCommit`,
`expectedFirmwareSourceCommit`, `expectedAppElfSha256`, `trust`). The flag is
mutually exclusive with every other mode: recovery phases, cadence, restart,
core-dump self-test, Noise, Stratum V2, station-endpoint handoff and soak.
It is sticky: a configured page refuses a change into or out of restoration
mode. The page refuses any other configuration, and the acceptance page never
admits unbudgeted leases, so no existing mode changes.

Only this configuration sets the controller hook flag
`allowClockDiscontinuityStimulus`. An adapter without that flag refuses the
stimulus before writing anything.

## Restoration leases

Restoration leases are unbudgeted Conservative Stratum V1 grants (decision D1):
no `acceptanceCampaign`, `qualificationAttempt` or `soakAllowance`, and no
`hardwareProfile` other than an absent or `conservative` value. Two windows are
accepted:

- 60,000 ms duration and 20,000 ms renewal point, with zero or one renewal of
  the same lease and window;
- 30,000 ms duration and 10,000 ms renewal point for the expiry scenario, with
  no renewal.

The development authority (`scripts/worker-development-authority.ts`) already
signs these shapes through `sign-start` and `sign-renew`; no authority change
is needed. Contract caps (at most ten Starts and two renewals per attempt) are
enforced by the local supervisor, not by the page.

## Page operations

The bundle `dist/worker-restoration/worker-restoration-page.js` is served by
`conformance/bwg-worker-serial-0.2/restoration.html` and publishes
`window.workerRestoration`. Nothing on the page schedules work: no timer
renews, stops or polls. Every operation returns closed values only.

| Operation | Effect |
| --- | --- |
| `configure(config)` | Validate and apply a restoration configuration (also loaded from `GET /context` at startup). |
| `connect()` / `reconnect()` | New controller, fresh permission, Hello and possession; `POST /activate` supplies the scope. Bound to the trusted `#connect` gesture. |
| `prepareStart()` | Fresh possession; posts `{controlSessionBindingSha256}` to `POST /authorization-context` for server signing. |
| `loadScenarioLease()` | `GET /scenario-artifacts` → `{grant, renewals}`, parsed as a restoration window. |
| `startScenarioLease()` | Delivers the loaded grant once. |
| `renewOnce()` | Delivers the next loaded renewal, if any. |
| `pause()`, `cancel()`, `restoreChallengeSatisfied()` | Ends the active lease with `paused`, `cancelled` or `restore(challenge_satisfied)`. |
| `triggerClockDiscontinuity()` | The bounded clock stimulus; one use per page lifetime, consumed even when refused. |
| `clockDiscontinuityStimulusReview()` | Fresh possession, then the read-only stimulus review. |
| `authorizationRejectionReview()` | Fresh possession, then the read-only rejection review, projected without its digest. |
| `statusReview()` | Status read; returns `{state, restoration, reason?}`. |
| `replayArtifact()` | `GET /replay-artifact` and deliver that previously signed artifact unchanged (N1–N4). |
| `beginPhysicalWindow()`, `armPhysicalWindow()` | `POST /physical-window` with `{event: "begin" | "arm"}`; begin requires an active lease, arm works while disconnected. |
| `physicalWindowState()` | `GET /physical-window`. |
| `close()` | Reads status first when a lease looks active, then closes (`restore(tab_closed)` only for a lease the device still holds). |
| `submitCompletion()` | Both reviews, close, supervisor flush, then `POST /completion-review`. |
| `state()` | The published page state, including the journal. |

Physical-window answers must be exactly `{checkpoint}` with a lower-case
`[a-z][a-z0-9_]{0,63}` token. `GET /completion-context` answers exactly
`{nonce}`; `POST /completion-review` receives `{nonce, reviews: {stimulus,
rejection}, final_state}` and must answer exactly `{result: "passed" |
"unverified", scenario, cleanup_confirmed: true}`. Completion requires the
supervisor client's `window.recoverySupervisor.flush()`.

### Scope continuity and replay

Every connect calls `/activate`. The supervisor may return the same scope
again, which keeps one challenge across reconnects within a scenario and across
the `reboot` → `authorization_negatives` pair. The page and controller accept
that repetition; each connect still needs fresh permission and possession.

A replayed Start must carry that persistent scope's challenge; the Gate's
local challenge check then passes and the artifact reaches the device, so the
device, not the Gate, decides. `replayArtifact()` refuses only an operation
that does not fit the page's lease state (a Start during a lease, a renewal
without one) before any write. Its result is one of:

- `{operation, outcome: "accepted"}`;
- `{operation, outcome: "rejected", category}` with the device's closed
  rejection category (for example `authentication_failed` or
  `admission_required`); the device revokes the transport epoch, and the page
  waits for the controller's fail-safe close and reports itself disconnected;
- `{operation, outcome: "failed", category}` with a closed local serial
  category when no device answer arrived.

## Wire shapes

All three commands are optional on Controller 0.4; older firmware answers
`invalid_request`, which fails the session closed. None carries status
evidence. `conformance/bwg-worker-controller-0.4/restoration-qualification-vectors.json`
holds valid and invalid request and response vectors.

`clock_discontinuity_stimulus` takes exactly `{"requestNonce": <22-character
canonical base64url of 16 random bytes>}`. The acknowledgement is exactly:

```json
{ "schema": "worker-clock-discontinuity-stimulus-v1", "requestNonce": "<echo>", "offsetMilliseconds": 1000, "armedForMilliseconds": 2000 }
```

The adapter requires the hook flag, a ready channel, an active lease and no
pending request or diagnostic fence. Once the request is sent, the adapter
refuses every renewal of that lease, and the page discards its remaining
renewals. A mismatched nonce or any other field fails the session.

`clock_discontinuity_stimulus_review` and `authorization_rejection_review`
carry no `payload` key at all. Each requires an idle channel without an active
lease and is preceded by a fresh possession proof. Responses:

```json
{ "schema": "worker-clock-discontinuity-stimulus-review-v1", "state": "idle|armed|consumed|expired", "offsetMilliseconds": 1000, "discontinuitiesDetected": 0 }
{ "schema": "worker-authorization-rejection-review-v1", "bootRejections": 1,
  "last": { "ordinal": 1, "operation": "start|renew", "signature": "valid|invalid|not_evaluated",
            "context": "current|mismatch|expired|absent", "replayGuard": "fresh|at_or_below_durable_high_water|unavailable|not_evaluated" },
  "highWater": { "advancedThisBoot": false, "fingerprintSha256": "<64 lower-case hex>" } }
```

Counts are u32. `last` is `null` exactly when `bootRejections` is zero, and
otherwise `1 ≤ last.ordinal ≤ bootRejections`. Unknown fields or values fail.

## Bounds

- Stimulus: once per page lifetime (page) and once per device boot (firmware);
  1,000 ms offset; armed for 2,000 ms real time after the acknowledgement is
  sent; the firmware requires at least 5,000 ms of lease headroom.
- No page timers; one renewal at most per loaded lease.
- Journal: at most 256 entries, oldest dropped and counted.

## Device-ended leases (F9)

When any status shows `state: "baseline"` while the adapter holds an active
lease, the adapter marks the lease inactive. The device already ended it
(expiry, `monotonic_reset`, `control_failed`, connectivity or reboot
restoration) and stored its reason, so `close()` no longer sends
`restore(tab_closed)` over it, and a later renewal is refused locally. Page
`close()` reads status first for that reason. Leases the device still holds
are restored on close as before.

## Privacy

The published state, the journal and every operation result exclude
authorization strings, challenge and lease identifiers, possession bindings,
raw digests, nonces, and pool endpoint, user or password values. The journal
records closed event names with optional closed category tokens: restoration
reasons, rejection categories, serial failure categories, admission stages and
review states. The rejection review's high-water digest stays in the page: it
is replaced by `fingerprintMatchesLatestObservation` and
`fingerprintFirstObservedEpoch`, and `state().highWaterEpoch` counts observed
high-water changes in this page lifetime. The possession binding goes only to
the local supervisor for signing, as on the acceptance page.

## Non-claims

The acknowledgement does not prove the stimulus fired; the stimulus review and
a status showing `monotonic_reset` do. A `monotonic_reset` reason alone is not
proof (it can label an ordinary stop). The rejection review proves
attribution only for the last rejection in this boot, and a replay's closed
wire category does not by itself distinguish the four negative legs. The page
proves no physical event, cold start or USB identity. Its journal and state are
observations for the supervisor's judge, not a verdict.
