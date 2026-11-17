# Ticket 19 policy pages: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Gate deployment serves draft operator policy, privacy and terms pages at the three
paths its consent screen and discovery document link, so a claimant other than the owner can read
what they agree to.

**Architecture:** Three static HTML files in `reference/policies/`. `scripts/serve-gate-origin.ts`
exports the one path-to-file table; both origin servers (the deployment's and the Ticket 06
rehearsal's) serve exactly those paths from it. The launcher proof checks each one loads.

**Tech Stack:** Bun, TypeScript, `bun:test`, Bash.

**Spec:** `.scratch/c-image-end-to-end-gate/issues/19-deployment-policy-pages.md`, section "Design".

## Global Constraints

- Paths are exactly `/policies/operator`, `/privacy` and `/terms`; every other path keeps its
  current answer (404 on the deployment front).
- Each page opens with a banner: `Draft, not yet reviewed by the operator or a lawyer.` plus its
  date, 2026-11-15.
- Text states only what the code does. Anything only the owner can supply or promise is a
  bracketed `[Owner: …]` marker: the operator's legal name, a contact, governing law, and whether
  retention runs on a schedule.
- No external resources (no remote scripts, fonts or images); inline styles copied from
  `reference/account-creation.html` (`system-ui`, `max-width: 40rem`).
- No IPs, MACs, SSIDs, credentials, pool users, workers, endpoints or personal contact details in
  the pages.

## Review Focus

- A trailing slash or extension (`/privacy/`, `/terms.html`, `/policies/`) must stay 404 on the
  deployment front, not reach the file system. Task 1 tests it.
- `HEAD` on a page must answer like `GET` (the front already allows both). Task 1's route returns
  the same response for both.
- A page claiming a deletion the code doesn't do: the Pool Adapter's 30-day cleanup runs in no
  binary, so privacy must not promise it. Task 2's review checks every retention sentence against
  `docs/protocol/bwg-0.1-data-governance.md`.
- The privacy page omitting that the raw payout address is sent to the pool as the Stratum
  username (`src/stratum_v1/credentials.rs:42`). Task 2's content test asserts the sentence.
- The rehearsal origin serving the pages differently from the deployment front. Task 3 makes it
  use Task 1's table.

---

### Task 1: The deployment front serves the three pages

**Files:**
- Modify: `scripts/serve-gate-origin.ts`
- Test: `scripts/serve-gate-origin.test.ts`
- Create (placeholder content until Task 2): `reference/policies/operator.html`,
  `reference/policies/privacy.html`, `reference/policies/terms.html`

**Interfaces:**
- Produces: `export const POLICY_PAGES: Readonly<Record<string, string>>` mapping each path to its
  repository-relative file, and `export function policyPageFile(pathname: string): string | undefined`.

- [ ] **Step 1: Write the failing tests** in `scripts/serve-gate-origin.test.ts`:
  - `maps each linked policy path to its page`: for `/policies/operator`, `/privacy`, `/terms`,
    `policyPageFile` returns `reference/policies/operator.html`, `privacy.html`, `terms.html`, and
    each file exists.
  - `serves no other policy-like path`: `policyPageFile` returns `undefined` for `/privacy/`,
    `/terms.html`, `/policies/`, `/policies/operator.html`, `/policies/../package.json`.
- [ ] **Step 2: Run** `bun test scripts/serve-gate-origin.test.ts`. Expected: FAIL, `policyPageFile`
  not exported.
- [ ] **Step 3: Implement** `POLICY_PAGES` and `policyPageFile` (exact lookup, no normalisation),
  and in `fetch`, after the page route: when `policyPageFile` matches, return the file with
  `content-type: text/html; charset=utf-8`. Create the three files with the banner only. Update
  the file's header comment to name the policy pages.
- [ ] **Step 4: Run** the same test. Expected: PASS.

### Task 2: Draft the three pages

**Files:**
- Modify: `reference/policies/operator.html`, `privacy.html`, `terms.html`
- Test: `scripts/policy-pages.test.ts` (new)

**Interfaces:**
- Consumes: `POLICY_PAGES` from Task 1.

- [ ] **Step 1: Write the failing tests** in `scripts/policy-pages.test.ts`, one concern each,
  over every file in `POLICY_PAGES`:
  - `every policy page opens with the draft banner`: contains
    `Draft, not yet reviewed by the operator or a lawyer.` before the first `<h1>`.
  - `every policy page loads nothing remote`: no `src=` or `href=` beginning `http`, no `@import`.
  - `the privacy page says the pool receives the payout address`: privacy contains
    `sent to the pool as the miner's Stratum username`.
  - `the privacy page promises no deletion it can't keep`: privacy contains `[Owner:` within the
    retention section, and doesn't contain `automatically deleted`.
- [ ] **Step 2: Run** `bun test scripts/policy-pages.test.ts`. Expected: the three content tests
  FAIL on the placeholders.
- [ ] **Step 3: Write the pages** to the design's outline, every fact from the sources it names
  (`docs/protocol/bwg-0.1-data-governance.md`, `src/lifecycle.rs`, `src/pool_offer.rs:478-486`,
  `docs/design/v1-policy-defaults.md`, ADR-0107, ADR-0108, ADR-0061, ADR-0071, ADR-0008). Link the
  three pages to each other with relative paths (`/privacy`, `/terms`, `/policies/operator`).
- [ ] **Step 4: Run** the test. Expected: PASS. Then read each page against its sources once,
  sentence by sentence, and fix any claim the code doesn't support.

### Task 3: The rehearsal serves them, and the launcher proof checks them

**Files:**
- Modify: `scripts/serve-rehearsal-origin.ts`, `scripts/rehearse-gate-deployment-launch.sh`

**Interfaces:**
- Consumes: `policyPageFile` from Task 1.

- [ ] **Step 1: Rehearsal origin.** Before its static fallback, serve `policyPageFile(pathname)`
  when it matches, with the same content type.
- [ ] **Step 2: Launcher proof.** Beside the 404 loop, for each of the three paths require
  `curl --max-time 10` status `200` and `content-type` beginning `text/html`; fail naming the path
  and status otherwise. Add one printed line saying the policy pages load.
- [ ] **Step 3: Run** `bash scripts/rehearse-gate-deployment-launch.sh` (regtest, bounded by its own
  deadlines). Expected: passes and prints the new line. Run the Ticket 06 rehearsal
  (`bash scripts/rehearse-production-path.sh`) and, while its origin is up, `curl` the three paths
  for 200; if the script gives no hook for that, record it as not checked.

### Task 4: Checks and records

- [ ] **Step 1:** `bun test`, `bun run typecheck`, `bun run check:standards`; shellcheck the
  changed script if the repository's checks include it.
- [ ] **Step 2:** In Ticket 19, tick the Gate item, record what ran and the non-claims (drafts not
  reviewed; owner markers unfilled; the adapter cleanup and the placeholder pool endpoint left
  open), and set Status to `ready-for-human`.
- [ ] **Step 3:** Ask the owner before committing.
