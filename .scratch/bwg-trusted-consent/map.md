# BWG Trusted-Consent Implementation Map

## Parent

This child effort resolves the server and browser enforcement required by
[`bwg-core` Ticket 14](../bwg-core/issues/14-trusted-origin-consent.md) without renumbering the BWG
Core roadmap.

## Decisions so far

- Trusted Origin Confirmation is an Authority-owned aggregate, not a popup property.
- The approved WebAuthn profile requires a server challenge, UP, UV, and operator-trusted non-self
  attestation.
- A signed Trusted Consent Receipt is distinct from a Gate Pass and is consumed only by lease
  admission.
- Production material-term wiring consumes the explicit pending-reconfirmation seam from
  [`bwg-multi-worker-failover` Ticket 03](../bwg-multi-worker-failover/issues/03-equivalent-offer-failover.md).

## Delivery order

1. [x] [Authority attested WebAuthn ceremony](./issues/01-authority-webauthn-ceremony.md)
2. [x] [Signed receipt and lease enforcement](./issues/02-receipt-lease-enforcement.md)
3. [x] [Browser hardening and end-to-end evidence](./issues/03-browser-hardening-evidence.md)
4. [Material-change bridge](./issues/04-material-change-bridge.md), after
   `bwg-multi-worker-failover` Ticket 03
