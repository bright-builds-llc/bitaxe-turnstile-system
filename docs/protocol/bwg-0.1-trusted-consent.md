# BWG/0.1 Trusted Consent

## Delivery status

The Authority-side one-use attested WebAuthn begin/finish ceremony is implemented by child Ticket
01. The signed receipt and authoritative lease-start rule below are owned by child Ticket 02; popup
hardening and real receipt browser evidence are Ticket 03; production material-change classification
is Ticket 04 on BWG Core Ticket 20's replacement-offer path. Until those tickets resolve, parent
Ticket 14 remains claimed and deployments must not advertise complete Trusted Consent conformance.

Light and Standard local work remains eligible for embedded Work Consent under claimant and client
ceilings. Elevated Action Policies set `trusted_confirmation_required` in the Authority-signed Pool
Offer claims. The same signed flag is used when a later Pool Offer changes reward allocation, fees,
payout behavior, or privacy terms.

## Ceremony

The component opens the fixed `/v0/trusted-consent` path on the configured Authority origin with an
opaque challenge ID, disclosure SHA-256 digest, signed-offer SHA-256 digest, reason, and random
browser state. It accepts a response only from that exact origin and popup window with the exact
state. The trusted page independently reloads the challenge and signed terms before asking for
confirmation.

The Authority issues and retains a fresh unpredictable WebAuthn challenge, requires
`userVerification: "required"`, and requests direct attestation. It verifies the returned challenge,
exact origin, RP ID hash, user-presence and user-verification flags, credential signature, and a
non-self attestation chain against operator-configured trust anchors. Browser `direct` preference
alone is insufficient. Challenge state is one-use and expires with the displayed ceremony.

The production Gate Authority exposes:

- `POST /v0/challenges/{challenge_id}/trusted-consent` to start or recover the exact ceremony; and
- `POST /v0/challenges/{challenge_id}/trusted-consent/{ceremony_id}` to finish it.

An Elevated-enabled deployment must set `BWG_WEBAUTHN_RP_ID`, `BWG_WEBAUTHN_RP_ORIGIN`, and
`BWG_WEBAUTHN_TRUSTED_ATTESTATION_JSON`. The trust JSON is a non-empty list of CA PEM, AAGUID, and
operator description entries. Invalid or empty trust fails startup; a deployment without Elevated
policy leaves the ceremony verifier unavailable. Pending registration state remains server-side in
PostgreSQL, is leased for one concurrent finish, and is erased with creation options immediately
after terminal verification. Public responses retain only ceremony identity, deadline, and status.

Ticket 02 will make successful verification return an Ed25519 compact JWS with type
`bwg-trusted-consent+jws`. Its claims bind the Authority issuer, Work Challenge, exact disclosure
and signed-offer digests, confirmation reason, trusted origin, `BWG/0.1`, issue/expiry times, and
metadata-only WebAuthn facts:

```json
{
  "user_present": true,
  "user_verified": true,
  "attestation": "trusted_non_self"
}
```

The receipt is stored with Work Consent and passed to lease start. It is not a Gate Pass, login,
identity assertion, or reusable permission. Missing receipts, popup failure/closure/cancellation,
origin/source/state mismatch, signature failure, stale time, missing UP/UV, and untrusted/self
attestation all fail before work starts.

The conformance profile combines unit vectors for signed receipt binding and negative cases with a
real Chromium virtual-authenticator path for WebAuthn challenge/origin and UP/UV behavior. Production
attestation trust still requires testing with every supported physical authenticator model.

Primary WebAuthn requirements: [W3C Web Authentication Level 3](https://www.w3.org/TR/webauthn-3/).
