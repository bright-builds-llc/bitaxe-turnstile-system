# 12: Require trusted-origin consent for Elevated work

**What to build:** Elevated Work Requirements and materially changed Pool Offer terms require confirmation on a trusted Authority origin that an embedding website cannot silently suppress or replace.

**Blocked by:** 11: Protect account creation with an accessible Web Component.

**Status:** ready-for-agent

- [ ] Light and Standard local work can remain in the conforming component under client ceilings.
- [ ] Elevated work requires a trusted-origin confirmation surface before any lease starts.
- [ ] Materially changed reward, fee, payout, or privacy terms require trusted-origin reconfirmation.
- [ ] The trusted surface independently loads and verifies the signed challenge terms.
- [ ] Embedding options cannot disable or counterfeit required confirmation.
- [ ] Cancellation, popup failure, origin mismatch, and stale challenge cases fail safely.
- [ ] The complete browser acceptance seam covers both embedded and trusted-origin paths.
