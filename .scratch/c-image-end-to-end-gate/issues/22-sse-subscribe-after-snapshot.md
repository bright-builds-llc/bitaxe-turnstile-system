# Challenge events SSE can miss an update sent while it subscribes

Type: bug
Status: resolved
Blocked by: None

## Objective

Found while fixing Ticket 13. `GET /v0/challenges/{id}/events` (`challenge_progress` in
`src/authority/http.rs`) opens each stream in two steps per channel. `subscribe_lifecycle`
reads the lifecycle snapshot from the database, and only then subscribes to the challenge's
broadcast channel. `subscribe_progress` does the same for verified progress. A notification
sent between those two steps is lost to the new stream:

- An expiry task that is already scheduled can call `notify_lifecycle` after the stream read
  an `active` snapshot and before it subscribed. The stream shows `active` and never sees
  `expired`.
- Accepted work committed in the same window updates progress (and, when it satisfies the
  Work Requirement, the lifecycle) without the new stream seeing it.
- If no stream has subscribed to the challenge yet, there is no channel entry, and
  `notify_lifecycle` and `notify_progress` drop the notification outright.

The SDK and page read these events to decide what the claimant sees, so a lost `expired`
leaves a page claiming work is running on an expired challenge until it reconnects.

## Plan

- [x] A deterministic regression test, not timing-based, that sends a notification while the
  snapshot is being read and fails before the fix.
- [x] Subscribe (creating the channel when needed) before reading each snapshot, for
  lifecycle and progress. A duplicate is harmless because every event is a full snapshot.
- [x] A failed snapshot read leaves no channel entry behind, so unknown challenge IDs on the
  unauthenticated route don't grow the channel map.
- [x] `cargo fmt`, `clippy`, `build`, `test` and `bun run check:standards` pass.

## Answer

Root cause: both subscribe paths awaited the database read before they took a receiver, and a
`broadcast` channel only delivers to receivers that exist when it sends. The lifecycle path also
captured `now` in the HTTP handler before either step, so an expiry notified just before the
subscription could still produce an `active` snapshot.

Fix:

- New `src/authority_application/challenge_channels.rs`: `ChallengeChannels<T>` owns the
  per-challenge `broadcast` map that lifecycle and progress each kept a copy of.
  `subscribe_then_read` creates the channel if needed and subscribes, and only then awaits the
  snapshot read. A notification sent during the read is queued on the new receiver. If the read
  fails, the receiver is dropped and the channel removed when nothing else is subscribed, so an
  unknown challenge ID on the public `/events` route leaves no entry behind.
- `subscribe_lifecycle` and `subscribe_progress` use it. `subscribe_lifecycle` no longer takes
  `now`; it reads the clock inside the snapshot read, after subscribing. So an expiry that fired
  before the subscription is in the snapshot, and one that fires after it reaches the receiver.
- `notify_lifecycle` and `notify_progress` delegate to `ChallengeChannels::notify`, unchanged in
  behaviour. Dropping a notification when there's no channel is now correct: every stream has
  subscribed before it reads.

A stream can now see one state twice: once in its snapshot and once live. Every event is a full
snapshot, so clients already tolerate it; another stream connecting already re-broadcast the
current lifecycle to the others. The lifecycle read itself notifies, so a new stream always sees
its initial lifecycle twice. `web/headless-client.ts` maps each event to a state transition and
guards terminal handling with `terminalReported` and one shared restoration, so a repeat changes
nothing. The Rust SSE tests read until a state appears.

Tests, in `challenge_channels.rs`, with no database and no timing:

- `update_sent_while_the_snapshot_is_read_reaches_the_new_subscriber` notifies from inside the
  snapshot read. Before the fix it failed with `left: Err(Empty)`, `right: Ok("expired")`.
- `failed_snapshot_read_leaves_no_channel_behind` and
  `failed_snapshot_read_keeps_the_channel_of_an_open_stream` guard the cleanup.

Checks: `cargo fmt --all`, `cargo clippy --all-targets --all-features -- -D warnings`,
`cargo build --all-targets --all-features`, `cargo test --all-features` (one full run, all
passed) and `bun run check:standards`.

Non-claims: notifications from concurrent writers can still arrive out of order, as before (an
older progress snapshot after a newer one). Channel entries for real challenges are still never
removed once a stream has subscribed, as before.

## Comments
