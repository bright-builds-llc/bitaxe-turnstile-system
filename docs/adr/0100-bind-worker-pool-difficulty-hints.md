# ADR-0100: Bind Worker pool difficulty hints to signed leases

Accepted for the owner-authorized Worker qualification path. This extends
Controller 0.4 and Serial 0.2 without changing mining safety or lease duration.

## Decision

A Start grant may include `stratum.suggestedDifficulty`, an integer from 0 through
65535. The complete field participates in the existing Work Lease authorization
request digest. Absence and explicit zero remain distinct signed inputs, although
both disable a Worker pool difficulty hint. Null, negatives, fractions and values
outside the range are invalid. Renewal does not introduce or replace this field.

A positive value requests the existing pool suggestion operation in the firmware
adapter. The pool remains free to ignore it and remains authoritative for its
actual job/share target. It does not change the ASIC ticket filter, authorize work,
extend a lease, or guarantee an accepted share. Worker operation never falls back
to a saved NVS difficulty preference. Ordinary pools may use their own configured
hints; stored settings remain unchanged.

The signed serial application manifest must contain
`poolDifficultyHintProfile: worker-stratum-difficulty-hint-v1`. Its new digest is
`pDwsfWH5X8bHMTqyB0SgAxTKA0_KpzBqdSLxMpKVNhU`. Exact manifest parsing, capability
signatures, possession binding and deployment trust continue to enforce the
advertised semantics. Role-separated keys and durable authorization sequences are
unchanged.

The firmware qualification harness exposes the public choice
`--suggested-difficulty 1000`, freezes it in its context, and passes the resulting
Start JSON through Gate's existing private-input signing command. Neither repo
needs to read, edit, print or persist pool credential file contents to add the
hint. Canonical `stratum` signing order is `endpoint`, `password`, optional
`suggestedDifficulty`, `username`; explicit zero is not omitted.

## Verification and rollout

Public RFC8032 vectors cover omission, zero, 1000 and 65535, with signature-tamper
and malformed-value tests. Existing omitted-field contracts remain valid. Public
fixture regeneration uses `scripts/generate-worker-serial-fixtures.ts` and
`scripts/generate-worker-difficulty-hint-vectors.ts`; these use public or ephemeral
non-production keys only.

Publish Gate first, then pin its exact archive in firmware and build the clean
published firmware package. The new capability must be signed through the existing
protected Update Authority and verified against deployment trust before hardware.
Old manifest digests cannot admit this new profile. No hardware
acceptance or prior failure is promoted by these software changes.
