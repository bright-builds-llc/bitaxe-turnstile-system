# BWG Trusted Consent

**Status:** ready-for-agent

## Problem Statement

Ticket 14 requires consequential work to be confirmed independently of an embedding Relying
Service. Client-side popup and JWS checks alone cannot enforce this: the production Gate Authority
must verify a server-challenged attested WebAuthn ceremony, issue a disclosure-bound receipt, and
make that receipt mandatory at the authoritative lease-start boundary. Material Pool Offer changes
also need the pending-reconfirmation seam owned by `bwg-multi-worker-failover` Ticket 03 before they
can be classified in production.

## Solution

Add a Gate Authority-owned one-use Trusted Origin Confirmation aggregate. It persists a bounded
WebAuthn registration ceremony tied to one Work Challenge and exact disclosure/Pool Offer digests,
verifies UP, UV, origin, RP ID, credential signature, and operator-trusted non-self attestation,
then records a terminal verified result. A separate receipt slice signs that result and requires the
receipt at lease admission. The browser slice consumes only the signed receipt and cannot relax the
server rule. The failover child effort derives the same signed requirement from real prior/current
material-term classification, then consumes it in one composed parent-closure proof.

## Implementation Decisions

- Use a one-time attested WebAuthn registration ceremony rather than a reusable login credential.
- Retain registration state only server-side, bounded by the Work Challenge and a short ceremony
  deadline; never accept client-restored ceremony state.
- Require exact Authority origin, RP ID, server challenge, UP, UV, and a non-self attestation chain
  rooted in operator-configured trust anchors.
- Treat attestation roots and accepted authenticator models as deployment policy; an empty or invalid
  trust set makes Elevated challenge confirmation unavailable rather than falling back.
- Store only metadata required for replay prevention and receipt issuance. Do not export credential
  public keys, attestation chains, AAGUIDs, or user handles through BWG public/audit surfaces.
- Sign a short-lived Ed25519 Trusted Consent Receipt only from a terminal verified ceremony. Bind it
  to the Challenge ID, disclosure digest, signed-offer digest, reason, origin, and protocol version.
- Require the exact receipt at Authority/Pool Adapter lease start for every challenge whose
  authenticated Pool Offer claims require trusted confirmation.
- Keep popup launchers untrusted. They may transport a receipt, but cannot disable the requirement
  or replace Authority verification.
- Preserve Light and Standard embedded Work Consent under existing ceilings unless authenticated
  Pool Offer claims explicitly require trusted confirmation.

## Testing Decisions

- Unit-test pure ceremony/receipt state transitions and every replay/expiry/binding branch.
- Exercise production Authority HTTP routes and PostgreSQL persistence through public interfaces.
- Use deterministic attestation fixtures for server verification and Chromium virtual authenticators
  for browser orchestration; record physical-authenticator compatibility as a residual deployment
  requirement rather than simulating attestation trust.
- Prove a hostile or bypassing client cannot start a protected lease without a valid receipt.
- Keep every failure response and log metadata-only.

## Out of Scope

- Personal identity, account login, authenticator ownership, uniqueness, or proof of humanity.
- Remote deletion or non-discoverability guarantees for platform credentials.
- Material-term replacement/failover orchestration before `bwg-multi-worker-failover` Ticket 03 is
  resolved.

## Parent

This child effort closes [BWG Core Ticket 14](../bwg-core/issues/14-trusted-origin-consent.md).
