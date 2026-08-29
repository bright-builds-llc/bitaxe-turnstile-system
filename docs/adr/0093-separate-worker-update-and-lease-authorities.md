# Separate Worker Update and Work Lease Authorities

## Status

Accepted.

## Decision

Reference Firmware capability signing and Work Lease authorization use separate replaceable
Ed25519 authority roles. The Update Authority signs closed Reference Firmware capability claims
bound to the exact application descriptor. The Work Lease Authority signs
`bwg-worker-lease-authorization/0.1` over the exact authorizationless Start or Renew input and
active Challenge binding. Verifiers enforce the authority role; a key trusted for one interface is
never implicitly trusted for the other.

The Work Lease proof remains a compact JWS inside Controller 0.3's existing opaque
`authorization` string. Its protected type is `bwg-worker-lease-authorization+jws`; the signed
payload contains only operation, the SHA-256 digest of the complete authorizationless canonical
request plus active Challenge binding, the current possession-derived control-session digest, and
a canonical unsigned 64-bit decimal authorization sequence in
`1..=18446744073709551615` without a leading zero. The protected `kid` is restricted to
`[A-Za-z0-9_-]{1,32}` ASCII bytes and selects a trust entry that pins issuer, audience, authority
role, and profile. Keeping those fixed facts out of the payload makes the maximum legal header,
payload, and Ed25519 signature fit Controller 0.3's existing 512-byte authorization field; exact
boundary vectors enforce that proof. This avoids a Controller version change and avoids circularly
signing the authorization string itself.

Each Work Lease Authority key allocates sequences monotonically from durable service-local state.
Before Reference Firmware starts or renews work, it atomically persists that key's accepted
sequence as a metadata-only high-water mark. Non-increasing sequences and uncertain persistence
fail closed across restoration, process interruption, and reboot. Overlap rotation retains
independent high-water marks; an explicit destructive retirement operation removes the retired
key and its mark together.
Allocator exhaustion fails closed without wrapping or signing. The 512-byte compactness proof uses
the maximum 32-byte ASCII key ID, longest operation, two 43-character digests, 20-digit sequence,
and fixed 64-byte Ed25519 signature. With exact payload fields `operation`, `requestSha256`,
`controlSessionBindingSha256`, and `sequence`, and operation literals `start` or `renew`, the
maximum canonical header is 101 bytes, payload is 193 bytes, and compact base64url JWS is 481
bytes.

`WorkerController` remains unchanged. A separate `WorkerLeaseAuthorizationContext` interface lets
the possession-bound adapter derive a domain-separated control-session digest from the canonical
verified possession transcript: exact request plus signed response/JWK. The transcript binds the
fresh nonce, Challenge, capability, descriptor, and Device Identity; the same request answered by
another Device Identity produces a different digest. Only the final digest is sent to the
Authority. Reference Firmware computes it from the response it issued, accepts an unused Start
context for at most 60 local monotonic seconds, retains it only for the active lease's Renew path,
and invalidates it on every restoration, disconnect, reboot, monotonic reset, or control failure.

A service-local development deployment authority may create the two private keys beneath an
owner-only path outside every repository. Private keys are mode `0600`, never printed, logged,
packaged, exported, or committed. Public JWKs, overlap/retirement configuration, and signed
capability or authorization artifacts are separate outputs. Production deployments replace those
keys through the same public interfaces.

No remote administration API or Device Identity registry is introduced. Possession remains the
local physical-control prerequisite; Work Lease authorization remains deployment-wide and fully
input-bound rather than a persistent Device Identity grant.

## Rationale

Reusing the Update Authority for Work Leases would turn a long-lived software-distribution key
into an online mining authorization key and expand either compromise across unrelated powers.
Changing Controller 0.3 would invalidate completed strict fixtures even though its existing opaque
authorization seam was deliberately deployment-owned. Device-specific authorization would require
publishing Device Identity to a backend or adding pairing/registry state, contradicting the local
privacy and non-registry decisions.

## Consequences

- The Reference Client can trust an Ultra 205 capability without trusting its issuer to authorize
  Work Leases.
- Firmware can verify every Start/Renew field and active Challenge binding without wall time or a
  persistent device registry.
- A previously accepted authorization cannot restart or extend work after restoration or reboot.
- A withheld or cross-session authorization cannot outlive its fresh local possession context.
- The same possession request answered by another Device Identity cannot reuse the first context.
- Rotation uses explicit same-role public-key overlap followed by retirement.
- Copying a complete unexpired Work Lease remains a bearer-confidentiality concern; possession and
  browser permission prevent remote use of the owner's local USB device, but this profile does not
  claim device-specific backend authorization.
