# Require attested WebAuthn consent on the trusted origin

Because a Relying Service controls and can counterfeit its embedding page, Elevated work, remote
Worker dispatch, changed economic or privacy terms, pairing, and persistent-management enrollment
require confirmation on the trusted Gate Authority or Worker Management origin. Light and Standard
local work may remain in the Web Component under client ceilings.

The trusted surface uses a server-challenged WebAuthn ceremony requiring user presence, user
verification, and a non-self attestation chain accepted by operator-configured trust policy. It
independently reloads the immutable challenge and Authority-signed Pool Offer terms rather than
trusting opener-rendered text. Successful verification produces a short-lived Authority-signed
Trusted Consent Receipt bound to the challenge ID, exact disclosure digest, signed-offer digest,
confirmation reason, and Authority origin. The headless client and lease-start transport both
require that receipt. Embedding configuration can open or suppress the popup, but cannot mint a
valid receipt or make a required receipt optional.

The reference Authority uses the strict attested-registration interface from `webauthn-rs` and
enables its registration-state serialization solely to keep the opaque paired challenge state in
server-side PostgreSQL across restart. That state is never accepted from a client, exported, or
logged, is protected by a bounded verification lease, and is erased immediately after successful
verification. This trade-off preserves the WebAuthn requirement that registration state remain
server-side while providing response-loss recovery.

This is evidence of an approved trusted-origin ceremony, not proof that the authenticator operator
is a particular person. `attestation: "direct"` is only a browser request; the Authority must verify
the returned chain against its trust policy. Platform credentials may be discoverable or synced, and
the RP cannot remotely delete them, so BWG does not claim non-discoverability or hardware identity.
