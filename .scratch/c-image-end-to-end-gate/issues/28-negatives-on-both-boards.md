# Negatives on both boards through the deployed page

Type: task
Status: ready-for-human
Blocked by: 21, 26

## Objective

Run Ticket 21's harness on the C image through the deployed page, on the 601
and the 205 in one sitting. It can share Ticket 15's 601 sitting.

## Plan

- [ ] Withheld, expired-context and handed-over grants each fail before mining
  on a real board. The board stays restored, `ok=1`, with no Gate Pass. Only the
  control-session digest reaches the Authority.
- [ ] One board's grant handed to the other board is refused, because their
  contexts differ (both boards).
- [ ] After Ticket 26, a Cancel and an expiry release the port on a board.
- [ ] The acceptance page (`conformance/bwg-worker-serial-0.2/acceptance.html`)
  runs `interruptPendingStatusForQualification`, with no lease, on the C image.
  It records `helloRecovery.discardedReplies`. If the count is 0, the record says
  why: the firmware drops a reply for an old epoch before writing it
  (`components/bwg_worker/proto/bwg_writer.c`, `select_control`). This needs only
  one board.
- [ ] Watch every mining case for `stale_job`. Claim it only if the proxy logs
  one while a lease runs.
- [ ] Records go in the fork's `docs/project/gate-integration-evidence.md` and on
  this ticket, with non-claims. They name no endpoints, MACs or pool identities.

## Comments

- `scripts/gate-deployment-page-config.ts` discloses only `bitaxe-601`. The 205
  may need adding to the disclosure list. Both boards run the same image, so the
  commit and ELF pin hold.
