# C-image end-to-end Gate map

[Spec](spec.md). The first Gate on the C Reference Firmware image through the
production browser path. Tickets 01, 02, 03, 04, 06, 07, 08, 09, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 21, 22, 23, 24, 26, 27, 28 and 30 are resolved; the rest is still planning.
The first Gate (06, 07) and onboarding (14, 03, 04, 05, 15) run apart, and both
feed 09.

| Ticket | Type | Status | Blocked by |
| --- | --- | --- | --- |
| [01](issues/01-authority-worker-lease-grants.md) Authority issues signed Worker Lease grants and renewals | task | resolved | None |
| [02](issues/02-c-image-onboarding-contract.md) Agree the C image's onboarding contract | grilling | resolved | None |
| [14](issues/14-gate-onboarding-contract-for-the-c-image.md) Gate onboarding contract matches the C image | task | resolved | 02 |
| [03](issues/03-c-image-onboarding-commands.md) C image reports onboarding facts and guards its own boot | task | resolved | 02, 14 |
| [04](issues/04-web-serial-onboarding-device.md) Browser onboarding device over the ROM bootloader | task | resolved | 03 |
| [05](issues/05-signed-c-image-package.md) Owner signs the C image's firmware package (signed; licence review left) | task | ready-for-human | 03, 04 |
| [15](issues/15-c-image-onboarding-on-the-601.md) Onboarding on the 601, from stock and between reference images | task | resolved | 05 |
| [11](issues/11-late-work-delivery-after-renew.md) Authority judges a Work Event by the reading at which it was observed | task | resolved | 10 |
| [12](issues/12-terminal-refusal-of-uncreditable-work.md) Authority refuses uncreditable work terminally, and delivery stops retrying it | task | resolved | 11 |
| [06](issues/06-production-path-rehearsal.md) Compose and rehearse the production path | task | resolved | 12 |
| [07](issues/07-first-c-image-gate.md) First end-to-end Gate on the C image | task | resolved | 06 |
| [08](issues/08-interruptions-and-negatives.md) Interruptions and negatives on the C image | task | resolved | 07, 17 |
| [09](issues/09-core-mvp-evidence-map.md) Map C-image evidence onto the Core MVP | task | resolved | 08, 15, 27 |
| [10](issues/10-pool-adapter-claimant-intake-and-renewal.md) Pool Adapter takes claimant Pool Selection and extends Stratum sessions on Renew | task | resolved | 01 |
| [13](issues/13-flaky-sse-expiry-test.md) Lifecycle SSE expiry test flakes under load | bug | resolved | None |
| [16](issues/16-pool-adapter-grpc-process.md) Pool Adapter runs as its own process over gRPC | task | resolved | None |
| [17](issues/17-sdk-http-transport-and-renew.md) SDK claimant HTTP transport and component-owned Renew | task | resolved | 06 |
| [18](issues/18-postgres-test-readiness.md) PostgreSQL test container is used before it accepts queries | bug | resolved | None |
| [19](issues/19-deployment-policy-pages.md) Deployment serves its operator policy, privacy and terms pages | task | needs-triage | None |
| [20](issues/20-pause-overlaps-renew-and-start.md) Pause overlapping a Renew or an in-flight Start | bug | resolved | None |
| [21](issues/21-gate-negatives-harness.md) Gate negatives harness for the C image | task | resolved | None |
| [22](issues/22-sse-subscribe-after-snapshot.md) Challenge events SSE can miss an update sent while it subscribes | bug | resolved | None |
| [23](issues/23-relying-service-restart-replay-flake.md) Relying-service restart test replays a pass that was never consumed | bug | resolved | None |
| [24](issues/24-relying-service-accepted-at-flake.md) Relying-service tests run the action worker before the service's acceptance second | bug | resolved | None |
| [25](issues/25-governance-apply-exit-unexplained.md) Relying-service governance test hides why an Apply run exited non-zero | bug | needs-info | None |
| [26](issues/26-release-port-after-cancel-and-expiry.md) Gate page keeps the USB port after a Cancel or an expiry | bug | resolved | None |
| [27](issues/27-adapter-restart-replay-test.md) An adapter restart replays nothing creditable twice | task | resolved | None |
| [28](issues/28-negatives-on-both-boards.md) Negatives on both boards through the deployed page | task | resolved | 21, 26 |
| [29](issues/29-handed-over-in-two-profiles.md) Handed-over grants in two browser profiles (optional) | task | ready-for-human | None |
| [30](issues/30-second-tab-admission-reason.md) A second tab's refused admission gives no reason | bug | resolved | None |

## Decisions so far

- Ticket 01, ADR-0106: claimant Work Session routes on the Authority issue signed
  Worker Lease grants and renewals, and also carry claimant Pause and Cancel.
  Pool Selection stays at the Pool Adapter, which is Ticket 10.
- Ticket 10: Renew extends the Worker's Stratum session in place under the same
  password, rather than the renewal carrying fresh credentials. Credential
  generations are ordered by issue milliseconds. ADR-0107: claimant Pool
  Selection is an Authority route that keeps only the commitment. The Pool
  Adapter stores the raw choice until the challenge is terminal.
- Ticket 11: accepted work is judged by its reading inside the lease window,
  not by delivery time or order. Deduplication stops a second credit.
- Ticket 12, ADR-0108, on the owner's choices: work delivered after the
  challenge deadline is dropped. The Authority refuses uncreditable work with a
  typed, terminal refusal, and delivery retries only outages, with backoff. The
  refusal belongs to the adapter boundary and its shared vectors, not OpenAPI.
- Ticket 02, on the owner's choices: the first Gate runs on a 601 flashed by
  hand, and onboarding is proven apart from it. Onboarding covers stock ESP-Miner
  and reference updates, and every ESP-Miner build is settings schema `1`. The
  browser is the one writer, through the ROM bootloader with a pinned esptool-js.
  It refuses an unknown partition table before any write, never writes NVS except
  to restore the backup on rollback, and checks settings with nonce-keyed HMACs.
  The C image turns on app rollback and marks itself valid only after its own
  startup check. Upstream's table becomes scheme `esp32-factory-ota-ab`. The Worker
  Serial manifest shouldn't change. Ticket 14 records it in an ADR.
- Ticket 06, ADR-0109, on the owner's choices: the Pool Adapter's proxy, delivery
  and expiry sweep run in the Authority's process until Ticket 16 builds the gRPC
  process. The rehearsal crosses the Work Requirement with one synthetic share
  that only the rehearsal can send. Ticket 17 moves the HTTP transport and Renew
  into the SDK before anything past 07. `gate-authority` runs the proxy when
  `BWG_STRATUM_PROXY_LISTEN_ADDRESS` is set. Ticket 07 follows
  [run-sheet-07.md](run-sheet-07.md).
- Ticket 07, on the owner's choice: mainnet, on the owner's existing synced
  node (Bitcoin Core 31.1, a named deviation from the 28.1 pin) through an SSH
  tunnel, with `scripts/hydra-mainnet-stack.sh --external-node`. A pruned node
  without `-txindex`, which Hydra and job admission don't need, is the fallback.
- Ticket 07, on the owner's approval (2026-11-07): `scripts/launch-gate-deployment.sh`
  composes the deployment with the owner's keys, read from files at run time, on a
  Tailscale origin. It seeds the Work Lease sequence above the board's last known
  value, and records the high-water mark when it stops.
- Ticket 07, on the owner's choice (2026-11-07): Hydra keeps each Stratum
  connection across a new tip and sends the new job with `clean_jobs`, so a block
  no longer ends a Work Lease. A closed connection still stops its Work Session.
- Ticket 07 (2026-11-08): the client sends one restoration for all terminal
  events and no other controller command once it has begun, so a slow board
  restore no longer ends the serial session before redemption.
- Ticket 13 (2026-11-09): the lifecycle SSE expiry test gives itself a 3 s lead
  before the deadline and waits 6 s for `expired`. It failed 7 of 100 runs before
  and 0 of 100 after. Production code is unchanged, but a subscribe-after-snapshot
  window is noted on the ticket.
- Ticket 20 (2026-11-09): Start, Pause and Resume each hold a transitional
  control state (`starting`, `pausing`, `resuming`) until the board answers, and
  no other command or Renew is sent meanwhile. A failed control command leaves
  the work `paused`. Renew reports refusals without ending, and stops only on
  terminal.
- Ticket 08 (2026-11-09): the interruptions passed on the Ultra 205 through the
  deployed page, Pause and expiry on Ticket 20's fix. The negatives, adapter
  replay and `discardedReplies` need tooling the page lacks, so they move to
  Ticket 21.
- Ticket 14, ADR-0111 (amends ADR-0046): the manifest profile is
  `bwg-reference-firmware/0.2` with scheme `esp32-factory-ota-ab`, and `factory` may be
  active. Schema `1` names exact `main` keys per category, and every category digest is
  an HMAC under a per-onboarding nonce (`bwg-settings-hmac/1`), with shared vectors in
  `conformance/bwg-bitaxe-onboarding-0.2/`. The raw `nvs` copy lives in browser memory
  until `complete()` or any failure; then a rollback needs the optional download. Ticket 04
  must say how stock, which has no Worker Serial, is inspected and checked after rollback.
- Ticket 22 (2026-11-10): the `/events` stream subscribes to each channel before it reads the
  snapshot, and reads the lifecycle clock after subscribing, so an expiry or progress update sent
  meanwhile is delivered, at worst twice. `ChallengeChannels` in
  `src/authority_application/challenge_channels.rs` owns both channel maps.
- Ticket 23 (2026-11-11): before restarting, the relying-service restart test waits
  until the first redemption's consumption is committed, instead of sleeping 50 ms.
  The lost outcome-lookup test waits for its committed proof the same way. The test
  failed 3 of 190 loop runs before and 0 of 190 after. Production code is unchanged.
- Ticket 24 (2026-11-11): the relying-service persistence tests step the action worker from the
  redemption's `accepted_at_unix_seconds` as the service recorded it, not from the test's clock,
  and assert the executor's outcome. With the race induced, 4 tests failed in 10 of 10 runs
  before and 0 of 10 after. Production code is unchanged.
- Ticket 04 (2026-11-11), ADR-0112 (proposed then; accepted 2026-11-14): the production onboarding device
  writes through esptool-js 0.7.0 and reads the C image over Worker Serial, on the one port the
  user's gesture granted. Stock is inspected and a rollback to stock is checked from flash through
  ROM. The order is table check, image, then the C bootloader and table (from stock only, read
  back), then `otadata` as `NEW`. The signed `0.2` manifest gains `firstInstall` digests, and the
  package carries the bootloader and table, so Ticket 05 signs every byte written. Onboarding's own
  reconnects skip the gesture check but keep the full Hello and possession admission. Tested on
  simulated boards only. Its bounds are proposed and wait for the 601 sitting.
- Ticket 05 (2026-11-12): the agent half is done, and the ticket waits on the owner's signature
  ([signing-handoff-05.md](signing-handoff-05.md)). C `51e5af9` is built with the owner's trust.
  `esp-miner.bin` SHA-256 starts `b8104b945f195032`, and the ELF starts `dc8b8319c1f5fcda`. The
  unsigned `0.2` manifest passes admission's parser, and a throwaway-key dry run of the whole
  admission. The manifest stays at `0.1.0` to match the signed capabilities, and Ticket 03 changed
  nothing they sign. `sourceUrl` is the owner's placeholder. `sign-firmware-manifest` in
  `scripts/worker-development-authority.ts` is the owner's signing command.
- Ticket 05 review (2026-11-13), amending ADR-0112: onboarding from a pre-Ticket 03 reference image
  (`247d2cd`) no longer stops after Hello.
  - The image's `command_rejected`/`invalid_request` reply to `onboarding_inspect` is a typed
    "unsupported" result. The device then inspects from flash under the image's signed capability.
  - Install writes the signed bootloader and table wherever flash differs, because `247d2cd`'s
    bootloader has app rollback off.
- Ticket 21 triage (2026-11-14), on the owner's choices:
  - The authorization negatives use CDP interception of the Authority's grant
    responses on the deployed page. No production hook is added, and the dev
    lease authority stays in the launcher. Ticket 21 builds the harness and proves
    it on the rehearsal, and Ticket 28 runs it on both boards.
  - The page closes the port after a confirmed Cancel or expiry restoration
    (Ticket 26).
  - Adapter replay is a Rust restart test with a hardware non-claim (Ticket 27),
    run again under Ticket 16.
  - `discardedReplies` is checked on the acceptance page, not the deployed page,
    and a 0 is recorded with the firmware's reason (Ticket 28).
  - Ticket 08 is resolved. Its open items live in 21, 26, 27 and 28.
- Ticket 26 (2026-11-14): the headless client releases the Worker through `maybeReleaseWorker` once
  a Cancel or expiry restoration is confirmed, and the serial entrypoint closes the port with that
  reason. A confirmed Cancel is the terminal restoration, so the Authority's later report sends the
  board nothing. Completion still lets go at redemption, and an unconfirmed restoration keeps the
  controller's failure path. Tested on simulated boards only.
- Ticket 27 (2026-11-14): an in-process adapter restart replays nothing creditable twice.
  `tests/stratum_v1_proxy/adapter_restart.rs` sends real shares through
  `spawn_in_process_pool_adapter`. It stops after the Authority credits an event
  but before the outbox acknowledges it, then restarts the Authority and adapter
  on the same database. The reclaimed event is credited once, and the
  acknowledged one is not delivered again. No production change and no hardware.
  Ticket 16 reruns it restarting only the adapter.
- Ticket 16 (2026-11-15), ADR-0113, accepted by the owner: the Pool Adapter runs as the
  `pool-adapter` binary behind a loopback gRPC boundary with a channel token. The
  refusal vectors, claimant routes and Ticket 27's restart test pass through it,
  and the launcher starts it as its own process.
- Ticket 21 (2026-11-14): `scripts/gate-negatives-harness.ts` drives the reference page over raw
  CDP and pauses the Authority's Start and Renew responses with Fetch. It withholds a Start grant,
  holds one 65 s, or swaps two tabs' grants, then cancels through the page. All three passed on
  the rehearsal (`scripts/rehearse-production-path.sh --negatives`):
  - no lease, no Verified Progress, no Gate Pass, and the Authority ended each attempt `cancelled`;
  - the only board-bound request field was `control_session_binding_sha256`;
  - the fake board refuses a Start on a 60 s old context with `admission_required`, as the C board
    does;
  - a refused Start makes the page fail closed and drop the port.
  A handed-over Start grant is refused by the page's challenge check before it reaches the other
  board, so Ticket 28 can't observe the board's own context refusal through the page.
- Ticket 28 (2026-11-14): on the C image through the deployed page, `withheld` and
  `expired_context` passed on the 601, an expiry released the 205's port, and the 205 gave the
  first positive `helloRecovery.discardedReplies`. No stale job was logged. `handed_over` can't
  run in one browser profile, because the page's site-wide Web Lock refuses tab b's admission;
  Ticket 29 runs it in two profiles, and Ticket 30 covers what the second tab is told. Grants are
  per site, so a board granted on the acceptance page isn't granted on the Gate's site.
- Ticket 29 (2026-11-14): the harness opens `handed_over`'s tab b in its own browser context, the
  rehearsal now takes the page's real site-wide lock, and a real-browser test shows one profile
  admits one Worker Serial session. The run on both boards waits for a sitting with the owner.
  The owner made that run optional: it no longer blocks Ticket 09, and runs only when both boards
  are out for another sitting.
- Ticket 05 (2026-11-14): the owner signed the C image's manifest with the source set to the fork's
  public commit, and the Gate's package admission accepts it against the owner's trust for both
  boards. Ticket 15 can use the package now; ADR-0112 was accepted the same day. The
  licence reviews still block distributing the image to anyone else.
- ADR-0112 (2026-11-14): the owner accepted it, amended so that onboarding the 205 or the 601 must
  match the board's base MAC before any write. Ticket 15 is unblocked; wiring that check into the
  page or script for the sitting is its first item.
- Ticket 15 (2026-11-15): resolved. On the 601 the sitting page installed the signed package from
  `247d2cd` and from stock v2.15.4, updated `51e5af9` to `57b0841`, refused an unknown partition
  table with nothing written, and recovered a failed startup check through the bootloader and the
  page. Each install and rollback was verified, and the evidence is in the C repository's
  `docs/project/gate-integration-evidence.md`. Ticket 09 can take criterion 3 from it.
- Ticket 09 (2026-11-15): resolved. `spec.md`'s criteria table links every Core MVP criterion
  to its C-image evidence or names what is missing, and Core Tickets 23 and 25 carry the
  C-image evidence and non-claims.
- Tickets 03 and 04 (2026-11-15): resolved. Ticket 15's sittings measured the onboarding bounds
  on the 601, and both tickets record them.
