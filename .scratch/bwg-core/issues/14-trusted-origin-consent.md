# 14: Require trusted-origin consent for Elevated work

**What to build:** Elevated Work Requirements and materially changed Pool Offer terms require confirmation on a trusted Authority origin that an embedding website cannot silently suppress or replace.

**Blocked by:** Child effort `bwg-trusted-consent` through Ticket 04;
[`bwg-multi-worker-failover` Ticket 04](../../bwg-multi-worker-failover/issues/04-composed-failover-closure.md)
for the shared material-change closure. Original prerequisite Ticket 13 is resolved.

**Status:** resolved

**Child effort:** [`bwg-trusted-consent`](../../bwg-trusted-consent/map.md)

**Composed closure:**
[`bwg-multi-worker-failover`](../../bwg-multi-worker-failover/map.md)

- [x] Light and Standard local work can remain in the conforming component under client ceilings.
- [x] Elevated work requires a trusted-origin confirmation surface before any lease starts.
- [x] Materially changed reward, fee, payout, or privacy terms require trusted-origin reconfirmation.
- [x] The trusted surface independently loads and verifies the signed challenge terms.
- [x] Embedding options cannot disable or counterfeit required confirmation.
- [x] Cancellation, popup failure, origin mismatch, and stale challenge cases fail safely.
- [x] The complete browser acceptance seam covers both embedded and trusted-origin paths.

## Answer

The [`bwg-trusted-consent`](../../bwg-trusted-consent/map.md) child effort supplies the
Authority-owned attested WebAuthn ceremony, disclosure-bound one-use receipt, authoritative lease
gate, hardened popup/client transport, and real Chromium evidence. The composed failover closure
adds live active-challenge material reconfirmation: a signed changed-term candidate remains pending,
a receipt for other terms fails, and only the exact fresh receipt releases the reserved Work
Session. The embedded Light/Standard and Authority-origin Elevated/material paths are exercised by
the browser and PostgreSQL suites, while negative origin, cancellation, stale, popup, forgery, and
bypass cases remain fail closed.
