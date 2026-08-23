# 05: Export redacted snapshots and audit governance operations

**What to build:** A Service-Local Operator can stream and resume a coherent, redacted context export with an integrity manifest, while every privileged governance operation creates a metadata-only audit trail.

**Blocked by:** 03: Retire Gate Authority records safely; 04: Retire Relying Service records safely.

**Status:** ready-for-agent

- [ ] Both CLIs stream `bwg-governance-v1` NDJSON from an immutable Snapshot Cutoff and resume by export ID and sequence without duplicates or omissions.
- [ ] Completion emits a SHA-256 Governance Manifest with counts, byte totals, and the digest of preceding bytes; the service does not persist export files.
- [ ] Export and audit serialization excludes credentials, keys, proofs, passes, action payloads, payout/network/device/account identity, and pseudonymization secrets byte-for-byte.
- [ ] Context-local metadata-only events cover plan, apply, export, pseudonymization, deletion, failure, and recovery and expire after 90 days.
- [ ] Failed export and audit persistence behavior is fail-closed, operator-visible, and safely resumable.
