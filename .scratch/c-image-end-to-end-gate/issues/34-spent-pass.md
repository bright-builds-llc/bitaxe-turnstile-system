# A spent Gate Pass can't be reused or refreshed

Type: task
Status: resolved
Blocked by: None

## Objective

Criterion 10 reads: "The reference action executes idempotently, creates a Redemption Record, and
cannot reuse or refresh the pass." It's Partial. On the 601, only an identical resend of the
redemption was refused (Ticket 07). A fresh DPoP proof on a spent pass was refused only in a Rust
test, and no refresh was tried. The owner chose (2026-11-26) to close the criterion with one
mainnet journey on the Gamma 601.

## Plan

- [x] After the journey's own redemption, the negatives harness retries the spent pass as its
  claimant could:
  - it looks the pass up again with a fresh Issuance Proof;
  - it redeems the pass again with a fresh DPoP proof.
  Both are signed inside the page, with the page's own Claimant key and transport code
  (`scripts/gate-spent-pass-page.ts`, bundled in memory by `scripts/gate-spent-pass.ts`).
- [x] The journey's verdict fails in these cases:
  - the pass wasn't retried;
  - a second lookup returned a different pass;
  - the retry got anything but 401 `invalid_redemption`.
  The tab counts only the page's own redemption status.
- [x] `scripts/rehearse-production-path.sh --negatives` checks the Relying Service's log. It needs
  exactly one `Protected Action succeeded` and at least one `Gate Pass was already consumed`,
  because a 401 alone could be a malformed retry.
- [x] [Run sheet 34](../run-sheet-34.md) on the 601, on mainnet: the journey and the log checks
  pass.
- [x] The fork's evidence gets a Ticket 34 section, and criterion 10 in `spec.md` is updated.

## Comments

- 2026-11-26, before the sitting, on macOS arm64:
  - **The rehearsal passed.** `rehearse-production-path.sh --negatives` passed all four cases.
    - The journey's evidence: `refresh` `identical`, `replayStatus` 401 with
      `invalid_redemption`, and the page's own redemption 200.
    - The service's log: 1 `Protected Action succeeded` and 1 `Gate Pass was already consumed`.
    - The job admission join: 3 relayed and 3 admitted.
  - **Mutation: the retry's proof signed for a wrong URL.** The harness still passed on its 401
    `invalid_redemption`, but the rehearsal failed its log check, with 0 refusals as consumed. That
    shows why the log check is needed.
  - **Mutation: the recorder overwriting the page's redemption status.** The journey failed with
    "the redemption was answered 401".
  - Each mutation was restored from a backup copy, and the diff was checked.
- 2026-11-26, the sitting, 03:39 to 03:42 UTC, on the 601 with the owner's `247d2cd` image and the
  Gate at `b8025c9`, against Hydra on mainnet through the owner's Bitcoin Core 31.1 node:
  - **The journey passed.**
    - The consent named "Bitaxe Gamma 601" alone, estimating 29.3 s.
    - The Authority reached `pass_issued` at 03:40:26, and the page's redemption was answered 200.
    - The board stopped with `ok=1` after 32,013 ms of cooling.
  - **The spent pass:**
    - `refresh` `identical`;
    - the retry answered 401 `invalid_redemption`;
    - the service logged 1 `Protected Action succeeded` at 03:41:14.25, then 1 `Gate Pass was
      already consumed` 0.17 s later, 48 s into the pass's life.
  - **Job admission:** 4 relayed and 4 admitted. No stale job was logged.
  - **Afterwards:**
    - the board was paused with `mineOnBoot` 0 at 19 mV;
    - the launcher exited 0, the serve is off and the container gone;
    - Hydra and the tunnel are stopped.
  - The records are in the fork's `docs/project/gate-integration-evidence.md`, "Ticket 34: a spent
    Gate Pass".
