# Ticket 05 licence fixes: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The next C image anyone else receives can be rebuilt exactly from its public source and
ships with its licence notices, and the onboarding bundle ships the notices of what it carries.

**Architecture:** In the C fork, the web UI installs exactly its lockfile (`npm ci`), the public
trust inputs move into the tree, and a committed reference build script builds from a pushed commit
and writes the image, the build's `dependencies.lock`, a `SOURCE.txt` and a
`THIRD_PARTY_NOTICES.txt` produced by a tested generator. In the turnstile, a committed notices file
for the onboarding bundle is copied beside both onboarding bundles, and a test fails if a bundle
carries an npm package the file doesn't name. Image `51e5af9` stays on the owner's boards and is
not rebuilt.

**Tech Stack:** C fork: Bash, Python 3 (`unittest`), ESP-IDF v6.0.2, npm 11. Turnstile: Bun 1.4,
TypeScript, `bun:test`.

**Spec:** `.scratch/c-image-end-to-end-gate/licence-review-05.md`, "Proposed fixes": the owner chose
A2, B and C on 2026-11-18, accepted D and left E.

## Global Constraints

- C fork work follows its `AGENTS.md`: extensions in fork-owned files, narrow changes to upstream
  files, and every upstream file touched listed under "Sync Policy" with its reason (outside the
  managed block).
- Committed content holds no IPs, MACs, SSIDs, credentials, pool users, workers or endpoints. The
  trust and capability files are public (keys' public halves and owner-signed claims). No private
  key is read.
- Generated images stay outside both repositories.
- The trust inputs are byte-identical to `~/.bitaxe-fork-private/owner-trust/`'s.
- C fork checks before commit: `bash tools/run_bwg_host_tests.sh`,
  `bun scripts/bright-builds-check.ts all`, `idf.py build`. Turnstile: `bun test`,
  `bun run typecheck`, `bun run check:standards`, `bun run build:browser`.
- Nothing is committed or pushed without the owner's word.

## Review Focus

- A licence file deeper than the search reaches (lwIP's sits at `components/lwip/lwip/COPYING`) is
  missed without an error. Task 3's build check greps the notices for lwIP, mbedTLS, LVGL and cJSON.
- A dev-dependency whose code still ships (Tailwind's CSS) is left out by `npm ls --omit=dev`.
  Task 2 reads extra package names from `reference/notices/bundled-dev-packages.txt`; Task 3's check
  greps the notices for `tailwindcss`.
- The build leaving the worktree changed (as `npm i` did) means the source no longer matches the
  image. Task 3's script fails on any change and names the files.
- `npm ci` failing in the build on a lockfile out of sync with `package.json`. Task 1 checks
  `npm ci` in a clean directory.
- The onboarding bundle gaining a dependency without a notice. Task 4's test builds both entries and
  compares.

---

### Task 1: Axe-OS installs exactly its lockfile (C fork)

**Files:**
- Modify: `main/http_server/axe-os/package-lock.json` (synced), `main/CMakeLists.txt:183,216`
  (`npm i` → `npm ci`), `AGENTS.md` (Sync Policy list)

**Interfaces:**
- Produces: a committed lockfile that `npm ci` accepts; Task 3's clean-worktree check relies on it.

- [ ] **Step 1: Red.** In a scratch directory holding the committed `package.json` and
  `package-lock.json`, run `npm ci --ignore-scripts --no-audit --no-fund` (Node 24, npm 11.6.2).
  Expected: EUSAGE, `Missing: readdirp@4.1.2 from lock file` (seen 2026-11-18).
- [ ] **Step 2:** Discard the checkout's stray lockfile edit, then run
  `npm install --package-lock-only --ignore-scripts` in `main/http_server/axe-os`. Check that no
  existing package's `"version"` line changed (only additions and `peer`/`license` metadata), and
  that the result matches the stray edit's content.
- [ ] **Step 3:** Replace both `${NPM_EXECUTABLE} i` with `${NPM_EXECUTABLE} ci`. In `AGENTS.md`, add
  "install the web UI's dependencies from its lockfile with `npm ci`" to `main/CMakeLists.txt`'s
  reason, and a line for `main/http_server/axe-os/package-lock.json`: "synced with `package.json`, so
  `npm ci` installs exactly it".
- [ ] **Step 4: Green.** Step 1's command with the new lockfile exits 0 and leaves the lockfile
  unchanged (`cmp`).

### Task 2: Third-party notices generator (C fork)

**Files:**
- Create: `tools/third_party_notices.py`, `tools/test_third_party_notices.py`,
  `reference/notices/bitaxe-esp-miner.txt` (the Rust repository's MIT licence text, headed by one
  line naming what was moved: protocol text, test vectors, the trust and capability formats, and
  controller code translated from it), `reference/notices/bundled-dev-packages.txt` (one name per
  line: `tailwindcss`)
- Modify: `tools/run_bwg_host_tests.sh` (run the Python tests first, so CI runs them)

**Interfaces:**
- Produces:
  - `Component(name: str, directory: Path, origin: Literal["esp-idf", "project", "third-party"])`
  - `NpmPackage(name: str, version: str, directory: Path, declared_licence: str | None)`
  - `class MissingLicence(Exception)`, its message naming the component or package
  - `licence_files(directory: Path) -> list[Path]`: files whose name starts, case-insensitively,
    with `LICENSE`, `LICENCE`, `COPYING` or `NOTICE`, in the directory and two levels below,
    skipping `test`, `tests`, `test_apps`, `examples`, `docs` and `node_modules`; sorted.
  - `collect_notices(*, gpl_licence: Path, commit: str, source_url: str, components: list[Component], npm_packages: list[NpmPackage], extra_notices: list[Path]) -> str`
  - `main(argv: list[str]) -> int` with `--build-dir`, `--web-dir`, `--commit`, `--source-url`,
    `--output`. It reads `<build-dir>/project_description.json` (`build_component_info`,
    `project_path`, `idf_path`). A component's origin is `esp-idf` under `idf_path`, `third-party`
    under `<project>/managed_components` or outside both, else `project`. npm packages come from
    `npm ls --omit=dev --all --parseable` in `--web-dir` (root excluded) plus each name in
    `bundled-dev-packages.txt`, read from `node_modules/<name>/package.json`. Extra notices: ESP-IDF's
    `LICENSE` and `docs/en/COPYRIGHT.rst`, and `reference/notices/bitaxe-esp-miner.txt`.
- Output: a header (GPL-3.0, the commit, the source URL, "no warranty; see section 15"), the full
  text of `LICENSE`, the extra notices, then `== component <name> ==` / `== npm <name> <version> ==`
  sections with each licence file's text. A third-party component or npm package with no licence
  file and no declared licence raises `MissingLicence`; a project or ESP-IDF component without its
  own file gets no section.

- [ ] **Step 1: Write the failing tests** (`unittest`, temporary directories, one concern each):
  `test_header_names_gpl_commit_and_source`, `test_includes_full_gpl_text`,
  `test_third_party_component_licence_appears_under_its_name`,
  `test_rejects_third_party_component_without_licence` (message names it),
  `test_project_component_needs_no_licence`,
  `test_npm_package_without_file_shows_declared_licence` (section reads
  `declared licence: MIT; no licence file in the package`),
  `test_rejects_npm_package_without_any_licence`, `test_licence_search_skips_test_directories`,
  `test_licence_search_reaches_two_levels` (finds `a/b/COPYING`, not `a/b/c/COPYING`).
- [ ] **Step 2: Run** `python3 -m unittest tools/test_third_party_notices.py`. Expected: import
  error, module missing.
- [ ] **Step 3: Implement** the module to the interface above, and add
  `python3 -m unittest discover -s "$repo_root/tools" -p 'test_third_party_notices.py'` at the top of
  `run_bwg_host_tests.sh`.
- [ ] **Step 4: Run** the tests. Expected: all pass. Then `bash tools/run_bwg_host_tests.sh`.

### Task 3: Trust inputs in the tree and a reference build script (C fork)

**Files:**
- Create: `reference/trust/trust.json`, `reference/trust/capability-205.json`,
  `reference/trust/capability-601.json` (copied byte for byte), `reference/README.md` (what the
  inputs are; a new firmware version needs new owner-signed capabilities committed before its
  build; how to build and what to publish as the source release), `tools/build_reference_image.sh`
- Modify: `components/bwg_worker/CMakeLists.txt:12-14` (comment only: the reference build points
  `BWG_TRUST_DIR` at `reference/trust`), `TASKS.md` (open item: publish a source release with the
  first image distributed)

**Interfaces:**
- Consumes: Task 1's lockfile; Task 2's `main()` CLI.
- Produces: `tools/build_reference_image.sh [--local] <commit> <out-dir>`, writing into `<out-dir>`
  (which must not exist): `esp-miner.bin`, `esp-miner.elf`, `bootloader/bootloader.bin`,
  `partition_table/partition-table.bin`, `sdkconfig`, `dependencies.lock`, `COMMIT`, `IDF_VERSION`,
  `NODE_VERSION`, `SHA256SUMS`, `SOURCE.txt`, `THIRD_PARTY_NOTICES.txt`.

- [ ] **Step 1: Write the script** from the private `build_reference_at.sh`'s steps (detached
  worktree, submodules from the local objects, empty build directory), with these rules: refuses a
  commit not on `origin` unless `--local`, which writes "not published" into `SOURCE.txt`; requires
  `idf.py --version` to report v6.0.2 and Node 22 or later already on `PATH`; sets
  `BWG_TRUST_DIR="$tree/reference/trust"`; after the build fails, naming the files, if
  `git status --porcelain` in the worktree is not empty; checks the image holds the commit and no
  `dirty` version string; runs Task 2's generator; writes `SOURCE.txt` with the source URL
  `https://github.com/bright-builds-llc/bitaxe-esp-miner-c/tree/<full commit>`, the ESP-IDF and Node
  versions and the rebuild command. It prints no private value.
- [ ] **Step 2: Copy the trust inputs**, and check `cmp` against the owner-trust copies.
- [ ] **Step 3: Commit on the branch** (not pushed), then run
  `bash tools/build_reference_image.sh --local HEAD <scratch>/image-check`. Expected: exit 0; the
  worktree check passes; `THIRD_PARTY_NOTICES.txt` contains `GNU GENERAL PUBLIC LICENSE`,
  `lwIP`, `mbed TLS` or `Mbed TLS`, `LVGL`, `cJSON`, `chart.js`, `tailwindcss` and
  `Bright Builds LLC`; `SOURCE.txt` says "not published".
- [ ] **Step 4:** Point the private `build_reference_at.sh` at the committed script (outside the
  repository; not committed), keeping its output directory and refusal rules.
- [ ] **Step 5:** `bash tools/run_bwg_host_tests.sh`, `bun scripts/bright-builds-check.ts all`, and
  `idf.py build` in the checkout.

### Task 4: Onboarding bundle notices (turnstile)

**Files:**
- Create: `web/third-party-notices/bitaxe-onboarding.txt`, `scripts/third-party-notices.test.ts`
- Modify: `package.json` (`build:browser`: copy the notices to
  `dist/bitaxe-onboarding/THIRD_PARTY_NOTICES.txt` after that bundle), `scripts/build-worker-acceptance.ts`
  (copy it to `dist/bitaxe-onboarding-sitting/THIRD_PARTY_NOTICES.txt`),
  `conformance/bwg-bitaxe-onboarding-0.2/sitting.html` (a "Third-party notices" link)

**Interfaces:**
- The notices file has one `== <package> <version> ==` header per bundled package: `esptool-js
  0.7.0` (the package's Apache-2.0 `LICENSE` and Espressif's notice from its README), `esptool-js
  flasher stubs (esp-flasher-stub v1.2.2)` (the MIT text and
  `Copyright (c) 2026 Espressif Systems (Shanghai) CO LTD`, from `LICENSE-MIT` at esptool-js tag
  `v0.7.0`), and `pako` and `atob-lite` at their installed versions with their licence files.

- [ ] **Step 1: Write the failing tests:**
  - `the onboarding notices name every npm package each onboarding bundle carries`: for
    `web/bitaxe-onboarding-entry.ts` and `web/bitaxe-onboarding-sitting-page.ts`, `Bun.build`
    (browser, ESM, no outdir), collect `// node_modules/<package>/` markers from the output, and
    expect each as a `== <package> ` header.
  - `the onboarding notices carry the stubs' MIT terms`: contains the Espressif 2026 copyright and
    `Permission is hereby granted`.
  - `the onboarding notices carry esptool-js's Apache licence`: contains `Apache License` and
    `Version 2.0, January 2004`.
  - `the sitting page links its notices`: `sitting.html` contains
    `href="/dist/bitaxe-onboarding-sitting/THIRD_PARTY_NOTICES.txt"`.
- [ ] **Step 2: Run** `bun test scripts/third-party-notices.test.ts`. Expected: FAIL, the file is
  missing.
- [ ] **Step 3: Write** the notices file, the copies and the link.
- [ ] **Step 4: Run** the test (PASS), then `bun run build:browser` and check both
  `THIRD_PARTY_NOTICES.txt` files exist, then `bun test`, `bun run typecheck`,
  `bun run check:standards`.

### Task 5: Records

- [ ] **Step 1:** In the review, record the owner's choices (A2, B, C; D accepted; E left) and what
  was built. In Ticket 05, a comment with what ran and the non-claims (no image rebuilt or signed; no
  source release published; no lawyer review; the notices were checked by keyword, not audited); the
  licence item stays open until the first distributed image ships with its source release and
  notices. Update `map.md`'s row 05.
- [ ] **Step 2:** Ask the owner before committing either repository.
