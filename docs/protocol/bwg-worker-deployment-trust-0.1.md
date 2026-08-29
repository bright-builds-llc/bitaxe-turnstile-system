# BWG Worker Deployment Trust 0.1

## Scope

`bwg-worker-deployment-trust/0.1` defines the replaceable public trust needed to admit one signed
Ultra 205 Reference Firmware capability and to authorize complete Controller 0.3 Start/Renew
inputs. It does not change Controller 0.3, publish Device Identity, create a device registry, grant
persistent control, or define a remote administration API.

## Separate authority roles

One deployment publishes disjoint Ed25519 authorities:

- the **Update Authority** signs `bwg-reference-firmware-capability/0.1`; and
- the **Work Lease Authority** signs `bwg-worker-lease-authorization/0.1`.

Each trust entry fixes issuer, audience, role, and profile around one to eight unique public JWKs.
Key IDs are ASCII `[A-Za-z0-9_-]{1,32}`. A key ID or public key appearing in both roles invalidates
the complete trust document. Rotation adds a same-role overlap key; destructive retirement removes
an inactive key and its replay high-water state together.

## Ultra 205 capability

The development Update Authority signs Controller 0.3 capability claims for
`bitaxe-ultra` revision `205`, Reference Firmware, Worker USB 0.2, and the SHA-256 digest of the
exact application descriptor. The browser verifies that capability using only
`updateAuthority.keys`. Work Lease keys cannot satisfy capability verification.

## Possession-derived authorization context

`WorkerLeaseAuthorizationContext` is separate from the stable `WorkerController` interface. After
verifying a possession proof, the browser and firmware hash this canonical transcript:

- profile `bwg-worker-control-session/0.1`;
- the exact strict possession request; and
- the exact verified signed response and Device Identity JWK.

Only the resulting `controlSessionBindingSha256` reaches the Gate Authority. The transcript, proof,
JWK, Device Identity fingerprint, and USB identity do not. The same request answered by another
Device Identity produces a different context.

An unused Start context expires after 60 local monotonic seconds. A successful Start retains it
only for that active lease's Renew authorizations. Pause, Cancel, expiry, explicit Restore,
disconnect, reboot, monotonic reset, or control failure invalidates it; Start/resume then requires a
fresh possession transcript.

## Work Lease authorization

The compact JWS protected header is exactly:

- `alg: Ed25519`;
- `kid`: the bounded Work Lease Authority key ID; and
- `typ: bwg-worker-lease-authorization+jws`.

The canonical payload contains exactly:

- `operation`: `start` or `renew`;
- `requestSha256`: SHA-256 of the domain-separated authorizationless request;
- `controlSessionBindingSha256`; and
- `sequence`: canonical unsigned 64-bit decimal `1..=18446744073709551615`, without a leading zero.

The request digest includes profile, configured issuer and audience, operation, active Challenge
ID, and the complete authorizationless parsed request. Start therefore binds protocol, Lease ID,
Challenge ID, Stratum endpoint/user/password, duration, and renewal hint. Renew binds protocol,
Lease ID, duration, renewal hint, and the retained active Challenge ID.

The maximum canonical header is 101 bytes, payload is 193 bytes, and compact Ed25519 JWS is 481
bytes. Controller 0.3's unchanged authorization limit is 512 bytes. Unknown header/payload fields,
513-byte strings, malformed encodings, wrong trust role, changed input/context, and sequence
overflow fail closed.

Each Work Lease Authority key allocates sequences from durable service-local state. Reference
Firmware atomically persists the accepted per-key sequence high-water mark before any Start or
Renew effect. Non-increasing sequences, corruption, or uncertain persistence fail closed across
restoration and reboot.

## Development deployment authority

`bun scripts/worker-development-authority.ts` provides service-local `init`, `sign-capability`,
`sign-start`, `sign-renew`, `rotate`, and confirmed `retire` commands. Private role-separated JWK
registries and sequence state require owner-only directories and mode `0600`; private bytes are
never printed. Capability output is public. Work Lease authorization output remains mode `0600`
because it is credential material.

## Conformance artifacts

- [`fixtures.json`](../../conformance/bwg-worker-deployment-trust-0.1/fixtures.json) publishes the
  public development trust, exact signed Ultra 205 capability, Start/Renew inputs and signatures,
  size facts, and closed negative categories.
- [`contract.schema.json`](../../conformance/bwg-worker-deployment-trust-0.1/contract.schema.json)
  is the strict Draft 2020-12 fixture schema.
- `bwg-core/worker-deployment-trust` exports browser runtime signing/parsing/verification and
  authorization-context types.
- `bwg-core/worker-deployment-trust-conformance/fixtures` and `/schema` expose the artifacts to
  firmware and host consumers.
