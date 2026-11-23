# Negatives on both boards through the deployed page

Type: task
Status: resolved
Blocked by: 21, 26

## Objective

Run Ticket 21's harness on the C image through the deployed page, on the 601
and the 205 in one sitting. It can share Ticket 15's 601 sitting.

## Plan

- [x] Withheld and expired-context grants each fail before mining on a real
  board. Handed-over moves to [Ticket 29](29-handed-over-in-two-profiles.md). The board stays restored, `ok=1`, with no Gate Pass. Only the
  control-session digest reaches the Authority.
- [ ] One board's grant handed to the other board is refused, because their
  contexts differ (both boards). Moved to Ticket 29.
- [x] After Ticket 26, a Cancel and an expiry release the port on a board.
- [x] The acceptance page (`conformance/bwg-worker-serial-0.2/acceptance.html`)
  runs `interruptPendingStatusForQualification`, with no lease, on the C image.
  It records `helloRecovery.discardedReplies`. If the count is 0, the record says
  why: the firmware drops a reply for an old epoch before writing it
  (`components/bwg_worker/proto/bwg_writer.c`, `select_control`). This needs only
  one board.
- [x] Watch every mining case for `stale_job`. Claim it only if the proxy logs
  one while a lease runs.
- [x] Records go in the fork's `docs/project/gate-integration-evidence.md` and on
  this ticket, with non-claims. They name no endpoints, MACs or pool identities.

## Answer

Ran on 2026-11-14 with the Gate at `59981fe`, both boards on the reference image
of `247d2cd`, and nothing flashed. The fork's `docs/project/gate-integration-evidence.md`,
"Ticket 28 on both boards", has the rows and non-claims.

- **`withheld` and `expired_context` passed on the 601.** Each challenge ended
  `cancelled`, with Verified Progress 0 and no Gate Pass request. The audit found
  no board value in any Authority request.
- **The expiry released the port on the 205.** The challenge expired, and 90 s
  later the page had closed the port, with no Gate Pass.
- **`discardedReplies` was positive on the 205**, the first on any firmware: 1
  on each of five fast reconnects, and 0 on reconnects through the chooser.
- **No stale job was logged.**
- **`handed_over` can't run in one browser profile.** The page takes one
  site-wide Web Lock (`bwg-worker-serial`, `ifAvailable`) before admission, so
  tab b fails admission while tab a holds it, whichever board is picked.
  [Ticket 29](29-handed-over-in-two-profiles.md) runs it in two profiles.
- **Until the owner granted the 601 on the Gate's site, the page reused the
  205's grant with no chooser.** A `withheld` and an `expired_context` passed
  there by accident. [Ticket 30](30-second-tab-admission-reason.md) covers what
  the page says to a second tab.

## Comments

- `scripts/gate-deployment-page-config.ts` discloses only `bitaxe-601`. The 205
  may need adding to the disclosure list. Both boards run the same image, so the
  commit and ELF pin hold.
- 2026-11-14, from Ticket 21: run `scripts/gate-negatives-harness.ts` with
  `--browser`, `--origin` and `--payout-address-file`, in a Chrome started with
  `--remote-debugging-port`. A person picks each tab's port when Chrome asks.
  - A handed-over Start grant doesn't reach the other board: the page refuses it
    at the grant's challenge, since the two tabs' challenges differ. "Refused
    because their contexts differ" can't be seen on the board through the page.
    What the run can show is that the two control-session bindings differ and
    neither board mines.
  - Any Start the board refuses makes the page fail closed and drop the port, so
    the expired-context case ends with the port closed rather than a confirmed
    `cancelled` restoration.
- 2026-11-14, prepared: [run-sheet-28.md](../run-sheet-28.md).
  - The node answers through the tunnel. The acceptance page reaches
    `configured` on the reference image with no board attached.
  - The private board-values file holds 8 values. The boards' Device Identity
    keys aren't among them, which is a non-claim.
  - The disclosure list stays `bitaxe-601` only, because adding the 205 would
    double the duration estimate.
- 2026-11-14, the sitting: the Gate's site and the acceptance page's site hold
  separate grants, so the 601 needed its own grant on the Gate's site. The
  harness opens each tab in a new window, which hid tab b's chooser from the
  owner. Three tries left tab a's challenge with a lease the board never
  received, and each ended at expiry as `challenge_expired`. The launcher
  recorded lease sequence 15,049.
- 2026-11-21: the page config now lists both boards, each with the model and revision its signed
  capability reports, and the client discloses only the one connected, with its own duration
  estimate. A board no configured Worker names is refused before consent. Branch
  `consent-names-connected-board`. Not yet seen on a board.
- 2026-11-21, criterion 13: the negatives audit now reads each tab's Device Identity fingerprint
  from the page's `bwg-worker` store after admission and searches for it with the board values. It
  allows the payout address only as the pool selection's `payout_destination`, and searches every
  Start and Renew grant for the payout and the board values. The rehearsal's three cases passed with
  these checks. The rehearsal keeps continuity in memory, so the store read first runs at this
  sitting. Branch `privacy-boundaries`.
- 2026-11-22: the store read, the payout and grant checks, and the 205's consent screen move to
  [Ticket 32](32-privacy-consent-handover-on-both-boards.md). It adds a mining journey per board,
  so the audit also sees Renew grants and the redemption.
