# 11: Protect account creation with an accessible Web Component

**What to build:** A Relying Service can protect reference account creation through a framework-agnostic SolidJS custom element that uses the headless client and completes the full simulated BWG journey accessibly.

**Blocked by:** 10: Obtain Work Consent through the headless client.

**Status:** ready-for-agent

- [ ] The custom element supports inline, modal, and full-page presentation without duplicating domain logic.
- [ ] A plain HTML integration can create and redeem the reference account-creation challenge.
- [ ] Keyboard navigation, screen-reader semantics, focus behavior, contrast, and reduced motion meet the agreed accessibility expectations.
- [ ] The component distinguishes Verified Progress, Activity Estimate, success, Pause, Cancel, expiry, and fallback states.
- [ ] Host styles do not break the component's semantic behavior.
- [ ] Source, protocol version, short commit, and build provenance are visible in normal product chrome.
- [ ] Configured alternatives appear when no compatible Worker is available without claiming proof of humanity.
