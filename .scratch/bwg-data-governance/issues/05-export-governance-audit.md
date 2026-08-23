# 05: Export redacted snapshots and audit governance operations

**What to build:** A Service-Local Operator can stream and resume a coherent, redacted context export with an integrity manifest, while every privileged governance operation creates a metadata-only audit trail.

**Blocked by:** 03: Retire Gate Authority records safely; 04: Retire Relying Service records safely.

**Status:** resolved

- [x] Both CLIs stream `bwg-governance-v1` NDJSON from an immutable Snapshot Cutoff and resume by export ID and sequence without duplicates or omissions.
- [x] Completion emits a SHA-256 Governance Manifest with counts, byte totals, and the digest of preceding bytes; the service does not persist export files.
- [x] Export and audit serialization excludes credentials, keys, proofs, passes, action payloads, payout/network/device/account identity, and pseudonymization secrets byte-for-byte.
- [x] Context-local metadata-only events cover plan, apply, export, pseudonymization, deletion, failure, and recovery and expire after 90 days.
- [x] Failed export and audit persistence behavior is fail-closed, operator-visible, and safely resumable.

## Answer

Both Service-Local Operator CLIs now freeze redacted, context-local export items at one Snapshot
Cutoff and stream versioned NDJSON pages by export ID and sequence. The final envelope binds type
counts, exact preceding byte count, and SHA-256 content digest; repeating a page is byte-identical
even after domain changes. The database stores only temporary structured redacted snapshot state,
not framed NDJSON or an exported file, and retires it after 90 days. Metadata-only audits are committed with successful
plan/apply/export effects, record failure and recovery categories separately, and retire at the same
90-day floor. Byte scans cover Authority secrets plus Claimant, Action Reference, pass, issuer, and
Account Identity values.
