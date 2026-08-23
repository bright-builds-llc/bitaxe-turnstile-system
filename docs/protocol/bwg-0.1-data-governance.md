# BWG/0.1 Data-Governance Profile

This profile defines technical retention, retirement, export, and audit behavior for BWG protocol
and operational records. It does not govern Account Identity or application business records and
does not claim compliance with a jurisdiction-specific regime.

## Operator threat model

- A Service-Local Operator acts through a context-specific CLI, host access, and a least-privileged
  database role. Claimant Issuance Proofs and Claimant Outcome Proofs are never operator credentials.
- Gate Authority and Relying Service roles remain separate even in one PostgreSQL cluster. There is
  no remote governance HTTP route, shared governance transaction, or cross-schema foreign key.
- Destructive Apply is disabled by default. It requires an enabled deployment mode, an exact
  Governance Manifest digest, and explicit operator confirmation.
- Logs, telemetry, audit events, exports, and manifests may contain operation identifiers, counts,
  durations, digests, and bounded error categories, but never credentials, keys, signed artifacts,
  action payloads, payout data, network secrets, Account Identity, or Device Identity.

## Hosted retention matrix

All durations are measured from the record's protocol-specific terminal instant. A configured
period may be longer but never shorter than its applicable Retention Floor.

| Context | Record class | Retention Floor | Hosted transition |
| --- | --- | --- | --- |
| Gate Authority | Claimant issuance proof replay identity | Proof freshness plus skew | Delete immediately after the floor |
| Gate Authority | Signed Gate Pass bytes | Signed expiry plus verifier skew | Delete immediately after the floor |
| Gate Authority | Challenge, Work Session, share fingerprint, and Accepted Work Event | Stable acknowledgement and reconstruction remain safe | Pseudonymize at day 30; delete tombstone at day 90 |
| Gate Authority | Gate Pass Issuance Intent and outbox metadata | Issuance is terminal and signed artifacts cannot validate | Pseudonymize at day 30; delete tombstone at day 90 |
| Relying Service | DPoP and Claimant outcome proof replay identity | Proof freshness plus skew | Delete immediately after the floor |
| Relying Service | Pass Consumption | No conforming verifier can accept the Gate Pass | Pseudonymize at day 30 or later floor; delete tombstone at day 90 or later floor |
| Relying Service | Redemption Record and Protected Action Outcome | Outcome terminal; public lookup is independently bounded | Pseudonymize at day 30; delete tombstone at day 90 |
| Relying Service | Action Execution Intent and attempts | Protected Action Outcome is immutable terminal | Pseudonymize at day 30; delete tombstone at day 90 |
| Either | Governance audit event | Event committed | Delete at day 90 |

Pseudonymized Tombstones retain only context, record class, terminal status, policy or action type
when non-identifying, terminal timestamps, transition timestamps, and a context-keyed HMAC identity.
They contain no public Claimant or Action Reference and cannot support Claimant-facing lookup.

## Retention lifecycle

1. `plan-retention` fixes an `as_of` instant, validates the Retention Policy against every floor,
   calculates eligible actions without mutation, persists a Governance Manifest, and prints its
   digest and counts.
2. `apply-retention` loads that exact manifest, rejects policy or digest drift, and advances one
   bounded transaction at a time. The durable cursor moves only in the same transaction as a batch.
3. A retry resumes the same manifest after its last committed cursor. Reapplying a completed
   manifest reports the existing completion without changing domain data.
4. Related rows are pseudonymized or deleted in referentially safe order inside one context. A
   batch failure rolls back and emits only a safe error category.

### Service-local CLI contract

The `gate-authority-governance` and `reference-service-governance` binaries expose the same command
shape while reading only `BWG_AUTHORITY_DATABASE_URL` or `BWG_RELYING_SERVICE_DATABASE_URL`,
respectively.

- `plan-retention --as-of <unix-seconds>` applies the hosted 30/90-day policy by default. Optional
  `--operational-retention-seconds` and `--tombstone-retention-seconds` values may extend but never
  shorten those windows. Planning writes only context-local job, ordered-item, and manifest metadata.
- The JSON plan includes the job ID, context, planning instant, policy, status, total eligible items,
  counts grouped by record class/action/eligibility reason, and a 64-character SHA-256 digest. It
  never exposes governed record identifiers.
- `apply-retention --job-id <uuid> --manifest-digest <sha256>
  --confirm-destruction [--batch-size <1..1000>]` advances at most one bounded batch. It additionally
  requires `BWG_GOVERNANCE_DESTRUCTIVE_ENABLED=true`; absence is fail-closed.
- A job ID from the other context, a changed digest, missing confirmation, disabled destructive
  mode, an invalid batch bound, or a governed row changed since planning fails before a partial
  batch can commit. Retrying a completed job returns its stable completion cursor with zero new
  transitions.
- `export` is reserved on both CLIs and remains unavailable until the versioned export/audit profile
  is implemented.

## Export contract

Exports use `application/x-ndjson; profile="bwg-governance-v1"` and are streamed without persisting
the output file in the service. Every record envelope contains:

- `schema_version`, fixed to `bwg-governance-v1`;
- `context`, either `gate_authority` or `relying_service`;
- `export_id`, `snapshot_cutoff_unix_seconds`, and monotonically increasing `sequence`;
- `record_type` and a redacted, versioned `payload`.

Resume uses the export ID and last sequence against the same Snapshot Cutoff. Completion emits a
Governance Manifest with record counts by type, total bytes, and the SHA-256 digest of all preceding
NDJSON bytes. Raw Claimant keys, JWKs, proof or pass bytes, credentials, action payloads, payout and
network data, Account Identity, Device Identity, and pseudonymization keys are prohibited at the
byte level.

## Governance audit events

The context-local audit vocabulary is `retention_planned`, `retention_applied`, `export_started`,
`export_completed`, `export_failed`, `pseudonymized`, `deleted`, and `recovery_resumed`. Events
contain the context, operation ID, manifest digest when available, cutoff, counts, duration, outcome,
and a bounded error category. They never copy a governed row or operator credential.

## Prototype finding

The disposable logic prototype at branch
`codex/prototype-bwg-data-governance-lifecycle`, commit
`6a468d137d7cc7a4273bb00bdbe7266a1db68fcc`, validated five scenarios: safety-floor rejection,
interrupted batch resumption, independent context failure, repeatable export snapshots, and
day-30 pseudonymization followed by day-90 deletion. Its pure state model confirmed that eligibility
can be shared while manifests, cursors, transactions, and failures must remain context-local. The
HTML shell is intentionally absent from `main`.
