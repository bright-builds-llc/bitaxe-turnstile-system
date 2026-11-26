# A spent Gate Pass can't be reused or refreshed

Type: task
Status: in-progress
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
- [ ] [Run sheet 34](../run-sheet-34.md) on the 601, on mainnet: the journey and the log checks
  pass.
- [ ] The fork's evidence gets a Ticket 34 section, and criterion 10 in `spec.md` is updated.

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
