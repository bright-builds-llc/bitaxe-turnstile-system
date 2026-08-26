# BWG/0.1 Web Component

The framework-agnostic custom element is exported as `bwg-core/component` and registers
`<bwg-work-gate>`. It uses SolidJS reactivity inside open Shadow DOM, but accepts plain JavaScript
configuration and delegates every consent, control, progress, and key decision to the headless
client. The local UI primitives keep the self-hosted component small, style-isolated, and auditable
without introducing a second component-library theme inside host products.

Set `presentation` to `inline`, `modal`, or `full-page` before configuration. Then provide one
session loader, Relying-Service-configured alternatives, and immutable build provenance:

```html
<bwg-work-gate id="account-gate" presentation="inline"></bwg-work-gate>
<script type="module">
  import "./dist/component/bwg-work-gate.js";

  document.querySelector("#account-gate").configure({
    alternatives: [{ label: "Use email verification", href: "/email-verification" }],
    provenance: {
      sourceUrl: "https://github.com/bright-builds-llc/bitaxe-turnstile-system",
      protocolVersion: "BWG/0.1",
      appVersion: "0.1.0",
      maybeShortCommit: "abc1234",
      maybeBuild: "2026-08-23.1",
      maybeCiUrl: "https://github.com/example/repository/actions/runs/123",
    },
    async loadSession() {
      // Prepare the Claimant key, ask the backend to create the Work Challenge,
      // and return the configured headless client plus the Redemption adapter.
      return {
        client,
        compatibleWorkerAvailable: true,
        async redeem() {
          return { message: "Reference account created" };
        },
      };
    },
  });
</script>
```

Loading may create the public Work Challenge, but it never starts work. The first primary action is
explicitly “Consent and start work.” Pause and resume retain the headless lifecycle; Cancel opens a
focus-trapped terminal confirmation. Verified Progress uses a native closed-range `progress`
element and Authority values, while Activity Estimate stays separate text. Success, expiry,
failure, and policy fallback use distinct live regions and labels.

When the authenticated headless disclosure requires trusted confirmation, the same primary action
opens the fixed `https://<authority>/v0/trusted-consent` surface. The popup receives only opaque
challenge/digest/state values, independently renders the Authority-owned ceremony, and returns a
compact signed receipt through an exact-origin, exact-source-window, state-bound `postMessage`.
Popup blocking, closure, cancellation, wrong origin/source/state, or an invalid receipt leaves
consent unrecorded and work stopped. A custom popup launcher may be supplied for host integration,
but the component still passes its output through the headless signature and binding checks.
Disconnecting the component aborts the ceremony, closes the default popup, removes listeners and
timers, and ignores a late custom-launcher result before either consent or Start can run.

The dark default meets WCAG contrast targets, resets inherited host styling, exposes visible focus,
honors reduced motion, and traps focus in modal and Cancel surfaces. When no compatible Worker is
available, the component repeats the exact work requirement and presents only configured
alternative authorization paths. It never describes mining as proof of humanity or reports a
fallback as BWG success.

`bun run test:browser` builds the hosted/self-hosted artifacts and drives the plain-HTML conformance
page in Chromium. The page covers all three modes, keyboard focus, screen-reader landmarks and live
regions, contrast, reduced motion, host-style isolation, progress/activity separation, Pause,
resume, Cancel, expiry, fallback, provenance, simulated challenge creation, Gate Pass completion,
Redemption, and account-creation outcome.
