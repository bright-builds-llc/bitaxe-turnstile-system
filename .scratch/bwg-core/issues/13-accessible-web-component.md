# 13: Protect account creation with an accessible Web Component

**What to build:** A Relying Service can protect reference account creation through a framework-agnostic SolidJS custom element that uses the headless client and completes the full simulated BWG journey accessibly.

**Blocked by:** 12: Obtain Work Consent through the headless client.

**Status:** resolved

- [x] The custom element supports inline, modal, and full-page presentation without duplicating domain logic.
- [x] A plain HTML integration can create and redeem the reference account-creation challenge.
- [x] Keyboard navigation, screen-reader semantics, focus behavior, contrast, and reduced motion meet the agreed accessibility expectations.
- [x] The component distinguishes Verified Progress, Activity Estimate, success, Pause, Cancel, expiry, and fallback states.
- [x] Host styles do not break the component's semantic behavior.
- [x] Source, protocol version, short commit, and build provenance are visible in normal product chrome.
- [x] Configured alternatives appear when no compatible Worker is available without claiming proof of humanity.

## Answer

The publishable `bwg-core/component` package registers a framework-agnostic SolidJS custom element
whose Shadow DOM adapter delegates all consent, key, progress, and lifecycle behavior to the
headless client. Inline, modal, and full-page layouts share one dark accessible view; complete
signed Pool Offer economics and terms, both safety ceilings, Workers, cancellation semantics, and
exact work are visible before Start. Native progress semantics, separate activity text, live
status/error regions, focus-trapped modal and Cancel surfaces, visible focus, reduced-motion rules,
contrast checks, and host-style isolation cover the accessibility contract. Configured fallback
paths repeat the work requirement without calling mining proof of humanity or BWG success. Normal
chrome exposes source, app/protocol versions, linked commit/build provenance when available, and
explicit Unavailable values otherwise. Ten pure view-model tests and a real-Chromium plain-HTML
journey cover all modes, non-zero fees, Pause/resume, Cancel failure/retry, expiry, fallback,
simulated challenge creation, Gate Pass completion, Redemption, and account creation. The full
repository verifier passes, and Standards and Spec reviews against `59a1540` have no findings.
