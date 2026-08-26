# 14: Require trusted-origin consent for Elevated work

**What to build:** Elevated Work Requirements and materially changed Pool Offer terms require confirmation on a trusted Authority origin that an embedding website cannot silently suppress or replace.

**Blocked by:** Child effort `bwg-trusted-consent` through Ticket 04;
[`bwg-multi-worker-failover` Ticket 04](../../bwg-multi-worker-failover/issues/04-composed-failover-closure.md)
for the shared material-change closure. Original prerequisite Ticket 13 is resolved.

**Status:** claimed

**Child effort:** [`bwg-trusted-consent`](../../bwg-trusted-consent/map.md)

**Composed closure:**
[`bwg-multi-worker-failover`](../../bwg-multi-worker-failover/map.md)

- [ ] Light and Standard local work can remain in the conforming component under client ceilings.
- [ ] Elevated work requires a trusted-origin confirmation surface before any lease starts.
- [ ] Materially changed reward, fee, payout, or privacy terms require trusted-origin reconfirmation.
- [ ] The trusted surface independently loads and verifies the signed challenge terms.
- [ ] Embedding options cannot disable or counterfeit required confirmation.
- [ ] Cancellation, popup failure, origin mismatch, and stale challenge cases fail safely.
- [ ] The complete browser acceptance seam covers both embedded and trusted-origin paths.
