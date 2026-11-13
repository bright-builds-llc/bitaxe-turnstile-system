# C-image end-to-end Gate map

[Spec](spec.md). The first Gate on the C Reference Firmware image through the
production browser path. Tickets 01, 02, 06, 10, 11, 12, 13, 14, 17, 18, 20, 22, 23 and 24 are resolved; the rest is still planning.
The first Gate (06, 07) and onboarding (14, 03, 04, 05, 15) run apart, and both
feed 09.

| Ticket | Type | Status | Blocked by |
| --- | --- | --- | --- |
| [01](issues/01-authority-worker-lease-grants.md) Authority issues signed Worker Lease grants and renewals | task | resolved | None |
| [02](issues/02-c-image-onboarding-contract.md) Agree the C image's onboarding contract | grilling | resolved | None |
| [14](issues/14-gate-onboarding-contract-for-the-c-image.md) Gate onboarding contract matches the C image | task | resolved | 02 |
| [03](issues/03-c-image-onboarding-commands.md) C image reports onboarding facts and guards its own boot | task | ready-for-human | 02, 14 |
| [04](issues/04-web-serial-onboarding-device.md) Browser onboarding device over the ROM bootloader | task | ready-for-human | 03 |
| [05](issues/05-signed-c-image-package.md) Owner signs the C image's firmware package | task | ready-for-human | 03, 04 |
| [15](issues/15-c-image-onboarding-on-the-601.md) Onboarding on the 601, from stock and between reference images | task | ready-for-human | 05 |
| [11](issues/11-late-work-delivery-after-renew.md) Authority judges a Work Event by the reading at which it was observed | task | resolved | 10 |
| [12](issues/12-terminal-refusal-of-uncreditable-work.md) Authority refuses uncreditable work terminally, and delivery stops retrying it | task | resolved | 11 |
| [06](issues/06-production-path-rehearsal.md) Compose and rehearse the production path | task | resolved | 12 |
| [07](issues/07-first-c-image-gate.md) First end-to-end Gate on the C image | task | ready-for-human | 06 |
| [08](issues/08-interruptions-and-negatives.md) Interruptions and negatives on the C image | task | ready-for-human | 07, 17 |
| [09](issues/09-core-mvp-evidence-map.md) Map C-image evidence onto the Core MVP | task | ready-for-agent | 08, 15 |
| [10](issues/10-pool-adapter-claimant-intake-and-renewal.md) Pool Adapter takes claimant Pool Selection and extends Stratum sessions on Renew | task | resolved | 01 |
| [13](issues/13-flaky-sse-expiry-test.md) Lifecycle SSE expiry test flakes under load | bug | resolved | None |
| [16](issues/16-pool-adapter-grpc-process.md) Pool Adapter runs as its own process over gRPC | task | ready-for-agent | None |
| [17](issues/17-sdk-http-transport-and-renew.md) SDK claimant HTTP transport and component-owned Renew | task | resolved | 06 |
| [18](issues/18-postgres-test-readiness.md) PostgreSQL test container is used before it accepts queries | bug | resolved | None |
| [19](issues/19-deployment-policy-pages.md) Deployment serves its operator policy, privacy and terms pages | task | needs-triage | None |
| [20](issues/20-pause-overlaps-renew-and-start.md) Pause overlapping a Renew or an in-flight Start | bug | resolved | None |
| [21](issues/21-gate-negatives-harness.md) Gate negatives harness for the C image | task | needs-triage | 08 |
| [22](issues/22-sse-subscribe-after-snapshot.md) Challenge events SSE can miss an update sent while it subscribes | bug | resolved | None |
| [23](issues/23-relying-service-restart-replay-flake.md) Relying-service restart test replays a pass that was never consumed | bug | resolved | None |
| [24](issues/24-relying-service-accepted-at-flake.md) Relying-service tests run the action worker before the service's acceptance second | bug | resolved | None |
| [25](issues/25-governance-apply-exit-unexplained.md) Relying-service governance test hides why an Apply run exited non-zero | bug | needs-info | None |

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
- Ticket 04 (2026-11-11), ADR-0112 (proposed, for the owner): the production onboarding device
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
