# Worker Management

This context describes optional local and remote control of Workers. It does not determine gate policy, verify work, or issue authorization for protected actions.

## Language

**Worker Controller**:
The boundary through which a client starts, observes, cancels, and restores a Worker's challenge-scoped activity.
_Avoid_: Gate Authority, mining pool, arbitrary remote shell

**Worker Control Transport**:
A local bidirectional path that carries only authenticated Worker Controller requests and their redacted responses.
_Avoid_: Runtime log, evidence channel, remote shell

**Worker Evidence Transport**:
A local receive-only path for redaction-safe Worker observations that cannot authorize or accept Worker Controller requests.
_Avoid_: Worker Control Transport, command channel, credential stream

**Transport Reacquisition**:
The fail-closed process that binds a newly enumerated transport session to the same Worker before local control or evidence observation resumes.
_Avoid_: Device discovery, lease renewal, automatic reconnect

**Work Lease**:
A short-lived authorization for a Worker to perform one challenge's work, after which it must stop that activity and restore its Mining Baseline unless the lease is validly renewed.
_Avoid_: Persistent pool configuration, unbounded remote command

**Mining Baseline**:
The Worker's ordinary mining state captured before a Work Lease begins and restored when that lease ends.
_Avoid_: Challenge credentials, factory defaults

**Device Identity**:
A cryptographic possession identity generated and controlled by Reference Firmware that represents one Worker across authenticated management connections without claiming tamper-proof hardware attestation.
_Avoid_: Serial number, IP address, user account, hardware attestation

**Pairing Ceremony**:
A short-lived, explicitly confirmed process that proves local possession of a Device Identity before granting persistent management authority.
_Avoid_: QR scan, device discovery, account login

**Device Reclamation**:
A local-possession process that revokes inaccessible control and grants a new account authority over one Worker without recovering the prior Account Identity or its other data.
_Avoid_: Account recovery, fleet recovery, data export

**Control Grant**:
A revocable authorization allowing an account identity to perform a defined set of management actions for a Device Identity.
_Avoid_: Device private key, permanent ownership, login session

**Owner Grant**:
The sole v1 Control Grant authorized to administer, unpair, or transfer a Device Identity in addition to operating it.
_Avoid_: Device Identity, immutable owner, payout ownership

**Worker Authorization**:
A claimant-confirmed ceremony that lets a gate request narrowly scoped remote use of selected Workers without exposing the claimant's account to the Relying Service.
_Avoid_: Account login sharing, blanket site permission, Pairing Ceremony

**Worker Capability**:
A short-lived, proof-of-possession authorization limited to selected Workers and one Work Challenge.
_Avoid_: Account token, Control Grant, device-management session

**Device Relay**:
An optional intermediary that carries authenticated commands and status over connections initiated by remotely managed Workers.
_Avoid_: Inbound device port, Gate Authority, mandatory cloud

**Relay Session**:
An outbound TLS-protected connection authenticated by a Device Identity, carrying sequenced Protobuf commands and status without replacing each command's own authorization and expiry.
_Avoid_: Work Lease, device ownership, retained command queue

**Update Authority**:
A replaceable identity trusted by Reference Firmware to sign compatible remote update manifests and images.
_Avoid_: Device Relay, permanent vendor lock, local owner

**Migration Backup**:
An optional client-encrypted local recovery artifact for credential-bearing device settings, never uploaded to a management or gating service.
_Avoid_: Cloud backup, support bundle, plaintext export

**Telemetry History**:
Bounded, typed operational aggregates retained for an Owner's Worker under a disclosed duration and deletion policy.
_Avoid_: Raw log archive, credential store, permanent history
