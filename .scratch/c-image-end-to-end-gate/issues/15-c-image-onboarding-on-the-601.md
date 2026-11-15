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
- [ ] Stock ESP-Miner installs the signed C package. The category digests match
  before and after, and the device comes back with a fresh Hello and proof of
  possession.
- [ ] A reference-to-reference update installs a newer signed package the same way.
- [ ] A board on a reference image from before Ticket 03 (`247d2cd`, which both boards run)
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
