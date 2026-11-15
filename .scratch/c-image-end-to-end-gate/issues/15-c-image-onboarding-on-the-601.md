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
- [ ] Before the sitting: a page drives onboarding (Ticket 04 left this to Ticket 15). It loads
  the signed package, offers "Connect Bitaxe over USB" through `bitaxeUsbOnboardingAction`, and
  passes `baseMacAdmission(registeredBaseMacDigest(registry, "601"))` to
  `createUsbBitaxeOnboarding`, with the digest served from private configuration.
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
