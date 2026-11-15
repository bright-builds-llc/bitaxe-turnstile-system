# Onboarding on the 601, from stock and between reference images

Type: task
Status: ready-for-human
Blocked by: 05

## Objective

Prove onboarding on a real Gamma 601 with the owner's signed package, apart from
the first Gate (07). This is criterion 3's evidence for Ticket 09.

## Plan

- [x] Before the sitting: the base-MAC check (ADR-0112, required on the owner's boards) is ready
  to pass as `maybeAdmitBaseMac`, from the owner's private registry by digest, with nothing
  committing or printing a MAC. A board whose MAC differs is refused before any write.
- [x] Before the sitting: a page drives onboarding (Ticket 04 left this to Ticket 15). It loads
  the signed package, offers "Connect Bitaxe over USB" through `bitaxeUsbOnboardingAction`, and
  passes `baseMacAdmission(registeredBaseMacDigest(registry, "601"))` to
  `createUsbBitaxeOnboarding`, with the digest loaded from private configuration.
- [x] Stock ESP-Miner installs the signed C package. The category digests match
  before and after, and the device comes back with a fresh Hello and proof of
  possession.
- [ ] A reference-to-reference update installs a newer signed package the same way.
- [x] A board on a reference image from before Ticket 03 (`247d2cd`, which both boards run)
  installs the package. It is admitted, inspected from flash, gets the C bootloader, and is
  verified over Worker Serial. A rollback returns to `247d2cd`, and is checked from flash.
- [ ] A board with any other partition table is refused before anything is written.
- [ ] A failed startup check rolls back in the bootloader before mark-valid, and a
  browser-driven rollback after it returns to the previous slot with NVS restored.
- [ ] Evidence names the board, commits, image and ELF digests, timings and
  non-claims, and holds nothing private. The Migration Backup never leaves the
  browser.

## Comments
- 2026-11-13 (from Ticket 05's review): a 601 still on `247d2cd` is now an onboarding path of
  its own (see Ticket 04's comment).
  - It is admitted over Worker Serial and refuses `onboarding_inspect` as an unknown command.
  - It is inspected from flash, with the firmware from its signed capability.
  - The install also writes the C bootloader, because `247d2cd`'s has app rollback off.
  - On the board, confirm that the controller's reply really is `command_rejected`/`invalid_request`,
    and that the session ends after it.
  - An interrupted bootloader write on such a board can't be repaired from the browser. Esptool
    repairs it (ADR-0112).
- 2026-11-14: Ticket 05's package is signed and admitted against the owner's trust
  (`~/.bitaxe-fork-private/reference/package-51e5af9/signed-manifest.json`, with the image files in
  `image-51e5af9/`). Before the sitting, the owner accepts or amends ADR-0112. Ticket 05's licence
  reviews don't block this run, since installing on the owner's own board isn't distribution.
- 2026-11-14: the owner accepted ADR-0112, amended so that a base-MAC match before any write is
  required on the owner's boards. Ticket 15 has no remaining blocker; the first plan item is
  preparation before the sitting.
- 2026-11-15, the base-MAC check:
  - `web/bitaxe-base-mac-admission.ts` digests a base MAC as the Rust flash tool's board registry
    does (`bitaxe-board-registry-v1`: SHA-256 of `bitaxe-board-base-mac-v1`, a newline, and the
    MAC as lower-case colon hex), reads one board's digest from the registry
    (`~/Repos/bitaxe-esp-miner/boards.local.json`, ignored), and builds the admission. The page
    holds only the digest, never the MAC.
  - The hook is now awaited (`boolean | Promise<boolean>`), since WebCrypto's digest is async.
    Before, `esptoolRomAccess` called it synchronously, so an async check would have returned a
    promise, read as true, and admitted any board. `web/esptool-rom-access.test.ts` caught that
    with a fake esptool-js: another board's MAC is now refused on ROM entry with no write, the
    port closed and the lock released, and the expected board's MAC opens a session.
  - On the boards, read only: `espflash board-info` on each attached port, digested by
    `baseMacDigest`, matched the registry's 205 and 601 entries, one each. esptool-js's
    `readMac` reads the same eFuse words in the same format, but it runs in the browser for the
    first time at the sitting. Both boards came back on `247d2cd`, paused.
  - Checks: 1,383 TypeScript tests, typecheck, the browser build and the standards check pass. One
    run of seven had a single failure that the next six didn't repeat, and its name wasn't
    captured.
- 2026-11-15, the sitting page (`conformance/bwg-bitaxe-onboarding-0.2/sitting.html`, bundled by
  `scripts/build-worker-acceptance.ts`, served by `scripts/serve-headless-browser.ts`):
  - `web/bitaxe-onboarding-sitting.ts` runs the production `bitaxeUsbOnboardingAction` and pauses
    for the owner at each decision: Connect, then Install or Stop before install, then Keep C image
    or Roll back. It builds `createUsbBitaxeOnboarding` with the Gamma's USB filter, the
    configuration's Update Authority keys and `baseMacAdmission` over its digest. Its state,
    which the page shows and `window.bitaxeOnboardingSitting.state()` returns, names the board,
    the inspection, the result without its HMACs, and each device step's time and outcome. It
    holds no MAC, digest, passphrase or settings value.
  - `observeDeviceSteps` in `web/bitaxe-usb-onboarding.ts` times each device step (inspect, the
    settings read, flash, reboot, verification, rollback), for the evidence and for
    `task-onboarding-bounds-601`.
  - Private inputs come only through the page's file pickers. The configuration file is written
    by `~/.bitaxe-fork-private/reference/make_sitting_config.ts <205|601>` (mode 600) from the
    registry and the owner's public trust. The package is `package-51e5af9/signed-manifest.json`
    and the three files in `image-51e5af9/`.
  - Checked without a board: the simulator tests (Stop writes nothing; Install then Keep
    completes; Roll back is confirmed; a refused package fails and still releases the port; no
    secret in the state). Headless Chrome loaded the page with the real files set by path through
    CDP; it read `configured` for board 601 with only Connect enabled, and the digest wasn't in
    its state. The files joined as the page joins them were admitted by the configuration's trust
    against a stock 601 snapshot, version 0.1.0. 1,418 TypeScript tests, typecheck, the browser
    build and the standards check pass.
  - Not run: any connect to a board. The sitting's first step is a read-only dry run on the 601
    (Connect, the base-MAC check and the inspection, then Stop before install). It needs the
    owner's chooser pick, resets the board into ROM, and runs esptool-js's `readMac` in the
    browser for the first time.
- 2026-11-15, the read-only dry run on the 601 (bundle from `caf2306` plus the fixes below,
  uncommitted at the run; Chrome with a profile that already holds the 601's serial grant, so no
  chooser pick was needed after the first):
  - Three faults stopped the first runs; each has a test that was red before its fix.
    - The continuity store admits only `challenge_` identifiers, and onboarding's session used
      `onboarding_`, so Connect failed at once ("Worker continuity scope is invalid"). It is now
      `challenge_onboarding_` and random; a test builds the production onboarding without a port.
    - `247d2cd` rejects `onboarding_inspect` with `command_rejected` and then ends the session (as
      the 2026-11-13 comment predicted, now seen on the board). The browser still sent Close and
      waited for a credit that never came, so the sitting hung until the Worker Serial timeout.
      A rejected `onboarding_inspect` or `onboarding_verify` now skips Close, as a rejected Start
      already did (`web/worker-serial-onboarding-commands.test.ts`).
    - esptool-js 0.7.0's ESP32-S3 stub stalls reading flash over USB-Serial-JTAG with its 4 KB
      packets and 1,024 in flight, and leaves the MD5 unread; the 15 s read bound expired with no
      bytes. Reads now use our own loop: 256-byte packets, one in flight, a cumulative
      acknowledgement each, and the MD5 checked (`web/esptool-rom-access.ts`, five tests on a fake
      stub). ADR-0112 is amended for this, by the owner's choice at the dry run.
  - Then two runs passed, the same each time: Connect, ROM entry with the base-MAC check passing in
    the browser (esptool-js's `readMac`, first time), the flash table matching the C table, and
    inspection in 1.54 s (1,544 ms and 1,541 ms). The inspection read `firmware_required` for
    bitaxe-gamma 601 on `bright-builds-reference-firmware` 0.1.0, reference firmware, settings
    preservation `upgrade_required` at schema 1, Migration Backup optional. Stop before install
    then ended the sitting as `stopped`, with nothing written.
  - Afterwards the 601 reset into the app on `247d2cd`, paused, `mineOnBoot` 0. The 205 wasn't
    touched and is on `247d2cd`, paused.
  - Checks: 1,426 TypeScript tests, typecheck, the browser build and the standards check pass.
  - Non-claims: no install, rollback or verification has run; the refusal of another board's MAC
    is proven only against the fake esptool-js; the read loop is proven on this 601's
    inspection reads, not on a full-image read or another board.
- 2026-11-15, the install sitting's contract (attempt 1 on the 601, from `247d2cd`), written before
  any write:
  - Before the sitting: a base-MAC match, then esptool reads the whole flash to a private file and
    verifies it, as the recovery point outside the browser.
  - The sitting: the page from `0ce3b9f` with Ticket 05's package (`51e5af9`), Connect, the
    base-MAC check, inspection, Install with no Migration Backup, then the owner's Keep C image or
    Roll back. Each device step's time and outcome is recorded.
  - Closed outcomes: `complete` (installed and verified, then the owner's choice confirmed from
    the board); `continue_after_verified_fix` (a diagnosed defect gets one fix with a test, and a
    fresh attempt); `stop_repeated_boundary` (the same failure after its fix);
    `stop_hardware_blocker`. A failed install that the page recovers counts as a failure, not as
    a rollback proven. If the board is left unbootable, esptool restores the backup.
- 2026-11-15, attempt 1's outcome: a failure, recovered by the page. Connect and inspection
  passed (1.59 s), the settings read took 1.14 s and the flash step 36.4 s, then the reboot step
  failed at the 180 s bound. The page then rolled back on its own: the rollback took 9.3 s, the
  reboot 10.1 s, inspection from flash 1.48 s and verification 1.52 s, ending `rolled_back` with
  the rollback confirmed and settings preserved, on `247d2cd` in the factory slot. The recovery
  hid the reboot step's error, so the failure has no signature yet. Attempt 2 is diagnostic: a
  failed step now records its error and causes in the sitting's state, and an HTTP poll
  alongside shows whether the C image booted during the wait.
- 2026-11-15, attempt 2's outcome and the diagnosis:
  - The flash step passed again, and the HTTP poll showed `51e5af9` up about 40 s after the
    install began, staying up. The page never recorded the reboot: Chrome crashed about 40 s
    after the C image booted (`EXC_BREAKPOINT` on its IO thread, Chrome 157, a browser assertion
    with no script frames), while the page was reconnecting. The C image stayed installed,
    marked valid by its startup check, with no browser verification and no owner choice.
  - Loops without a write, on the C image now running: ten runs of onboarding's Worker Serial
    reconnect (Hello and possession, discover, `onboarding_inspect`, close) all passed, each in
    about 0.5 s, `bootable` on `ota_0`. The production reboot sequence without the flash step
    (Worker Serial inspect, ROM entry for the settings read, reset) failed at the first
    inspection with "Worker Controller public shape contains an unknown field".
  - Cause: `discover()` returns the signed capability (`transportProfile` and `attestation`
    around the semantic fields), and onboarding's snapshot parser accepts only the semantic
    fields. Every post-reboot attempt failed that parse and reconnected, until the 180 s bound
    (attempt 1) or until Chrome crashed in the reconnect loop (attempt 2). `247d2cd` never
    reached the parse, since it rejects `onboarding_inspect`; the simulator's capabilities carry
    no envelope, so no test saw it.
  - Fix: onboarding's Worker Serial link drops the envelope that admission verified. A test
    through `createUsbBitaxeOnboarding` on the fake serial board fails with the board's error
    before the fix and passes after. At the real boundary, with no write, the sitting's Connect
    on the C image now inspects over Worker Serial in 0.44 s: `ready`, settings `compatible`.
    1,428 TypeScript tests, typecheck, the browser build and the standards check pass.
  - Unexplained: the Chrome crash. The fix removes the reconnect loop that preceded it, so a
    repeat would be a new signature.
  - Next: write back the pre-install backup (after a base-MAC match) so the 601 is on `247d2cd`
    again, then attempt 3, a `continue_after_verified_fix`.
- 2026-11-15, attempt 3 (the fix above, uncommitted at the run; the 601 back on `247d2cd` from the
  verified backup): installed and verified, waiting for the owner's choice. Connect and
  inspection 1.62 s, the settings read 1.15 s, the flash step 36.5 s, the reboot 10.2 s until a
  bootable session, inspection over Worker Serial 0.32 s and verification 0.33 s. The result:
  `ready`, rollback not required, firmware 0.1.0 on `ota_0`, bootable, settings preservation
  confirmed for all, network and pool. The HTTP poll saw `51e5af9` running.
- 2026-11-15, attempt 3's outcome, `complete` for the `247d2cd` item: the owner chose Roll back.
  The rollback took 9.2 s and the reboot 10.1 s; inspection from flash (1.42 s) and verification
  from flash (1.44 s) confirmed it: `rolled_back`, rollback confirmed, settings preservation
  confirmed for all, network and pool, the factory slot bootable. The 601 then ran `247d2cd`,
  paused, `mineOnBoot` 0. Afterwards, read only after a base-MAC match, the 601's bootloader
  region equals the package's C bootloader, which differs from the one in the pre-install backup,
  so the install wrote it and the rollback kept it, as ADR-0112 says. The 205 wasn't touched.
  - Non-claims: stock ESP-Miner, a reference-to-reference update, a refused partition table, a
    failed startup check and a rollback that restores changed NVS are still open; the install
    used no Migration Backup; this is one run on one board; the Chrome crash in attempt 2 is
    unexplained.
- 2026-11-15, the stock install's contract (attempt 1 from stock on the 601), written before the
  sitting:
  - Staging: upstream's release image `esp-miner-factory-601-v2.15.4.bin` (from the
    `bitaxeorg/ESP-Miner` v2.15.4 release, matching the digest the release publishes; its table
    is the one onboarding names `upstream`, its app reports `v2.15.4`, and its OTA slots and
    `otadata` are blank). After a base-MAC match and a verified backup of the whole flash, it was
    written everywhere except `nvs`, and verified. The 601 then ran `v2.15.4` on its Wi-Fi.
    Unlike a board from the field, its `nvs` still holds the 601's settings and Device Identity,
    so the C image proves that identity rather than creating one.
  - The sitting: the page from `70dc172`, Ticket 05's package, Connect (stock sends no Hello, so
    inspection is from flash), Install with no Migration Backup, then the owner's choice. A
    rollback to stock is checked from flash, and HTTP shows whether stock runs.
  - Closed outcomes as in the earlier contract.
- 2026-11-15, the stock install, attempt 1: installed and verified, waiting for the owner's
  choice. Connect with inspection from flash took 4.28 s (stock sent no Hello): `firmware_required`,
  `esp-miner` 2.15.4, not Reference Firmware, settings `upgrade_required` at schema 1, Migration
  Backup recommended. Then the settings read 1.15 s, the flash step 36.6 s (with the C bootloader
  and table), the reboot 10.2 s until a bootable session with a fresh Hello and possession,
  inspection over Worker Serial 0.30 s and verification 0.31 s: `ready`, firmware 0.1.0 on
  `ota_0`, bootable, the category HMACs matching for all, network and pool. The HTTP poll saw
  `v2.15.4`, then `51e5af9`.
- 2026-11-15, the stock install's outcome, `complete` for the stock item: the owner chose Roll
  back. The rollback took 9.1 s; the reset into stock was unobserved (10.1 s, the fixed pause);
  inspection from flash (1.44 s) and verification from flash (1.41 s) confirmed it: `rolled_back`,
  rollback confirmed, `esp-miner` 2.15.4 in the factory slot, bootable, the category HMACs
  matching for all, network and pool. HTTP then showed `v2.15.4` running, as the user's check of
  the screen would. It was mining on the 601's saved pool, since stock has no `mineOnBoot` pause.
  This is the first rollback to stock on hardware. The C bootloader and table stayed, and boot
  stock.
  - Non-claims: the Device Identity the C image proved was the 601's existing one, kept in
    `nvs`, not one a board from the field would create; no Migration Backup was used; one run on
    one board.
