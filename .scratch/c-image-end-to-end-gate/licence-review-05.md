# Licence review before distributing the C image (Ticket 05)

Prepared 2026-11-18 by an agent for the owner's decision. It is not legal advice: it gathers the
facts and names the gaps, and the owner, ideally with a lawyer, decides. It covers the two things
Ticket 05 left open: the C image's GPL source and notice obligations, and the licence of
esptool-js 0.7.0's flasher stubs. ADR-0112, listed there as still proposed, was accepted by the
owner on 2026-11-14.

What is distributed: the signed package (`esp-miner.bin`, `bootloader.bin`,
`partition-table.bin`, built from C commit `51e5af9`) installed onto Bitaxe boards by the
onboarding page, and that page's browser bundle, which carries esptool-js and its stubs. The
manifest's signed `sourceUrl` names the fork's public tree at `51e5af9` as the image's source.

## Findings

### C image (GPL-3.0)

1. **The named source can't rebuild the distributed image. Gap.** The build embeds the deployment
   trust and both signed capabilities from `$BWG_TRUST_DIR`
   (`components/bwg_worker/CMakeLists.txt:16-18` at `51e5af9`), and none of those three files is in
   the tree. The public copies live in the MIT Rust repository under other names, and no script or
   document records the command that built the reference image. A GitHub archive of the tree has no
   `.git`, which the trusted build requires. The ESP-IDF Component Manager versions are ranges, its
   `dependencies.lock` is gitignored, and the web UI is built with `npm i` rather than `npm ci`, so
   the exact managed components and npm packages aren't recorded in the tree. The private build log
names the managed component versions. The reference build's worktree reported
`package-lock.json` modified by `npm i` and was then deleted, so the npm set behind the shipped
web UI wasn't kept. GPL-3.0 §6 requires the
   Corresponding Source, including the scripts used to control the build, to be available for as
   long as the object code is offered.
2. **Third-party notices aren't distributed with the binary. Gap, shared with upstream.** The image
   links lwIP, picolibc, FreeRTOS, mbedTLS, wpa_supplicant, libsodium, libsecp256k1, yyjson, cJSON,
   LVGL and others. Several carry BSD-style terms that require their copyright notice in the
   materials that come with a binary. ESP-IDF's own list is `docs/en/COPYRIGHT.rst`. The web UI is
   built with `extractLicenses: false` (`main/http_server/axe-os/angular.json:77`), so the MIT
   notices of chart.js, moment, rxjs and the rest are stripped. Upstream's releases ship the same
   way.
3. **Espressif's precompiled Wi-Fi and PHY libraries have no source.** They are Apache-2.0 binaries
   (`components/esp_wifi/lib/LICENSE`). Whether they count as System Libraries under GPL-3.0 is
   arguable. Every GPL ESP32 firmware, upstream included, ships them this way. The fork can't fix
   this; it can only accept upstream's position or take advice.
4. **Content moved from the MIT Rust repository carries no notice into the image or its source.**
   This covers the embedded trust and capability JSON, a test vector, the Worker Serial manifest
   text, and C controller code that may translate Rust code (the handoff notes no complete review).
   The owner's decision says such content keeps its MIT notice; today only the handoff document
   does. Inference: if the owner holds all copyright in the Rust repository, this is a promise to
   keep rather than an obligation owed to anyone else.
5. **No legal notices in Axe-OS.** The UI shows no copyright, warranty disclaimer or licence. GPL-3.0
   §5(d) says a modified work need not add them when the program's interface didn't display them,
   and upstream's doesn't, so this is optional.
6. **Installation Information: no gap.** Secure boot, flash encryption and signed apps are off, no
   eFuse is burned, rollback is on without anti-rollback, the OTA path checks no signature, and USB
   flashing is unaffected. The Gate admits only the commit and ELF it pins, so a modified build runs
   but isn't admitted to the owner's Gate. That is a service refusing a device, not the device
   refusing the user. Worth one line in a lawyer's review.
7. **Not reproducible byte for byte.** `CONFIG_APP_REPRODUCIBLE_BUILD` is off, so a rebuild won't
   match the signed digests. GPL doesn't require that.

### esptool-js 0.7.0 (onboarding bundle, MIT turnstile repository)

8. **The stubs are MIT or Apache-2.0, not GPL. No source obligation.** esptool-js `v0.7.0`'s
   `src/targets/stub_flasher/README.md` says the stubs were copied from esp-flasher-stub `v1.2.2`
   and are dual licensed Apache-2.0 or MIT, with both licence files beside them. The installed
   ESP32-S3 stub is byte-identical to that release's asset, whose source says
   `SPDX-License-Identifier: Apache-2.0 OR MIT`. npm leaves the README and both licence files out of
   the package, which is why the stubs looked unlicensed. esptool-js 0.6.1 and earlier carried
   esptool.py's GPL-2.0-or-later stubs, and so would ADR-0112's rejected option of uploading
   esptool.py's stub.
9. **The bundle ships no licence text. Gap.** Both onboarding bundles inline 13 stubs and
   esptool-js's code, but carry only pako's `@license` comment. Apache-2.0 §4 needs a copy of the
   licence and Espressif's copyright notice; the stubs under MIT need Espressif's copyright and the
   MIT text; atob-lite (MIT) needs its notice too.

## Proposed fixes and the decisions they need

| # | Fix | Where | Owner decision |
| --- | --- | --- | --- |
| A | Publish a source release for `51e5af9`: tag it (for example `reference-0.1.0`), and attach the three trust inputs under the names the build reads, the managed component versions from the build log, the ESP-IDF version, and the exact build command. Link it from a notices file served beside the package and from the onboarding page. The signed manifest and image stay as they are, but the web UI's exact npm set is lost, so this source is close to, not exactly, what built the image. | C fork | A, accepting the npm gap; or A2 (recommended): keep `51e5af9` on the owner's own boards only, and make the build exact now (the inputs and a reference build script committed, `npm ci`, `dependencies.lock` kept with the image), so the first image distributed to anyone is a new signed version whose source is exact. A2 costs a rebuild, new capabilities and a new signature at that point, which a new release needs anyway. |
| B | A third-party notices file for the image: ESP-IDF's copyright list and component licences, the managed components, the web UI's npm licences, and the Rust repository's MIT notice for moved content. Served beside the package, outside the signed bytes. Offer upstream the generator, since their releases share the gap. | C fork, turnstile | Yes / no; send upstream or not |
| C | A third-party notices file for the onboarding bundle: esptool-js (Apache-2.0 with Espressif's notice), the stubs (MIT with Espressif's notice, taken from the `v0.7.0` tag), atob-lite and pako. Served beside the bundle and linked from the page. A test fails if the bundle grows a dependency the file doesn't list. | turnstile | Yes / no |
| D | Accept upstream's position on the Wi-Fi and PHY binaries, or ask a lawyer. | — | Accept / ask |
| E | Leave Axe-OS's UI without legal notices, as upstream does. | — | Leave (recommended) / add an About notice, ideally upstream |

Whatever is chosen, keep `51e5af9` and its source release reachable for as long as the image is
offered, and have a lawyer read this before the image goes to anyone else.

Non-claims: no lawyer has reviewed this; the libraries were listed from the build's link map, not
audited file by file; the npm licences weren't enumerated; the main checkout's own modified
`package-lock.json` came from a later `npm i` and isn't known to match the reference build's.

## Owner's decisions and what was built

On 2026-11-18 the owner chose A2, B and C, accepted D and left E, and the fixes were built to
`plan-05-licence.md`:

- **A2 (C fork, branch `licence-notices`):** the web UI installs with `npm ci` from a lockfile
  synced with `package.json`; the deployment trust and both capabilities sit in `reference/trust`;
  `tools/build_reference_image.sh` builds a pushed commit in a fresh worktree, fails if the build
  changes the tree, and writes `dependencies.lock`, `SOURCE.txt` and `THIRD_PARTY_NOTICES.txt` beside
  the image. Image `51e5af9` stays on the owner's boards; the first image distributed is built this
  way, and its source release is `task-reference-source-release` in the fork's `TASKS.md`.
- **B (C fork):** `tools/third_party_notices.py`, with tests, writes the image's notices: the GPL,
  ESP-IDF's notices, the MIT notice for content moved from the Rust repository, and every built
  component's and bundled npm package's licence.
- **C (turnstile):** `web/third-party-notices/bitaxe-onboarding.txt` sits beside both onboarding
  bundles, the sitting page links it, and a test fails if a bundle carries a package it doesn't
  name.

A fresh review of both branches then found three gaps, and each was fixed with a test that failed
first:

- **Vendored code and fonts had no notices.** `reference/notices/vendored.txt` now carries the
  terms of code and fonts that sit in the tree rather than in a component: the SegWit address code
  and libbase58 (MIT), Espressif's DNS server (Unlicense or CC0), PrimeIcons (MIT), Digital Numbers
  and Open Sans Bold (SIL OFL 1.1), Mx437 Portfolio (CC BY-SA 4.0), Nippo and Angel Wish. The
  generator refuses to run if a tracked file carries a copyright header, is a font, or was converted
  from one, and that file names it in none of its sections.
- **The keyword check wasn't in the build.** `reference/notices/required-sections.txt` names the
  sections every notices file must hold (ESP-IDF's notices, lwIP, Mbed TLS, FreeRTOS, LVGL,
  libsodium, libsecp256k1, Angular, chart.js, Tailwind and others), and the generator fails without
  them. An npm package with no licence file now fails too, whatever licence it declares.
- **`npm ci` ran on every web UI edit.** One build step now installs the packages, only when
  `package.json` or the lockfile changes. The onboarding notices test also now checks each
  package's heading against its installed version, and that each bundle carries esptool-js.

### New finding: two upstream fonts may not be redistributable

The image carries two fonts that upstream ships, whose terms look stricter than the rest:

- **Nippo** (`Nippo-Regular.woff2`, in the web UI): the ITF Free Font License v2.0, as Fontshare
  publishes it, permits use in projects but forbids redistributing the font files and converting
  their format without the foundry's consent. The web UI serves the file to every browser that
  opens it.
- **Angel Wish** (`ui_font_AngelWish40.c`, the board's display, and `fonts_originals/AngelWish.ttf`
  in the source tree): the font file says "All rights reserved" by Stringlabs. The image carries
  seven of its glyphs (B, b, i, t, a, x, e), converted to an LVGL bitmap.

`vendored.txt` records what each says, but recording it doesn't grant a licence. This is upstream's
choice, and their releases ship both the same way. The owner decides whether to replace the fonts
(ideally upstream, since both projects carry them), ask the rights holders, or take advice. It
should be settled before the first image goes to anyone else.
