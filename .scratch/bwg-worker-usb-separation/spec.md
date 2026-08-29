# BWG Worker USB Separation

**Status:** ready-for-agent

## Problem Statement

BWG Core Ticket 21 published a strict `bwg-worker-controller/0.1` state machine and Web Serial
JSON-lines contract, while Ticket 23 requires the first real Reference Firmware and Bitaxe proof.
The firmware repository deliberately keeps its runtime serial evidence owner receive-only and
routes normal application effects through a separate control path. Its ESP32-S3 build also exposes
USB Serial/JTAG as a secondary output-only console. Sending Work Lease commands through that same
stream would mix protocol frames with logs, weaken the evidence contract, and contradict the
firmware repository's serial safety rules.

ESP32-S3 USB-OTG and USB Serial/JTAG share one internal PHY, so a second application USB controller
cannot run alongside USB Serial/JTAG without hardware that the Ultra 205 does not provide. The
system therefore needs an explicit application-time transport topology and bootloader/application
reacquisition contract before real hardware work can begin.

## Solution

Keep the higher-level `WorkerController` interface and Work Lease semantics stable. Controller 0.2
and `bwg-worker-usb/0.1` remain unchanged compatibility profiles. Publish a strict
`bwg-worker-controller/0.3` wire profile whose local transport profile is
`bwg-worker-usb/0.2`. Application-time Reference Firmware will enumerate one TinyUSB composite
device with two non-interchangeable functions:

- a vendor-specific WebUSB Worker Control Transport carrying only bounded possession and
  authenticated Controller frames with redacted responses; and
- a CDC Worker Evidence Transport carrying only redaction-safe, receive-only runtime observations.

ROM USB Serial/JTAG remains available only while the device is in its bootloader/debug lifecycle.
Moving between bootloader and application transports is an explicit Transport Reacquisition event,
not continuity of one serial session. Ambiguity, identity drift, unexpected function ownership,
control/evidence crossover, disconnect, reboot, or lost monotonic continuity fails closed and
restores the Mining Baseline before public completion.

Before an admitted application transport can start or resume a Work Lease, the client first runs
`bwg-worker-possession/0.1`: a Device Identity signature bound to `possessionNonce`,
`challengeBindingSha256`, the exact signed Controller capability digest, and the application
descriptor digest. The signed response also asserts the running firmware source commit; a client
with an exact expected package rejects any other commit inside the same Device Identity proof. USB
serial, VID/PID, and enumeration identity remain non-authoritative hints.

Deployment trust uses two replaceable Ed25519 authority roles. The Update Authority signs the
closed Reference Firmware capability bound to the exact application descriptor. The Work Lease
Authority signs `bwg-worker-lease-authorization/0.1` over the exact authorizationless Start or
Renew input, active Challenge binding, and durable monotonic authorization sequence. The compact
Work Lease JWS remains inside Controller 0.3's existing opaque 512-byte `authorization` string.
Issuer, audience, role, and profile are pinned by the keyed trust configuration rather than
repeated in the payload, keeping the maximum legal JWS representable without widening a strict
Controller shape.

A separate `WorkerLeaseAuthorizationContext` interface derives
`bwg-worker-control-session/0.1` from the canonical verified possession transcript: the exact
request plus signed response/JWK. That transcript binds the fresh nonce, Challenge, capability,
descriptor, running firmware source commit, and Device Identity. The headless client supplies only the final domain-separated
digest when asking the Authority for Start or Renew authorization. Firmware accepts an unused
Start context for at most 60 local monotonic seconds, retains it only while that lease is active,
and invalidates it on every restoration or continuity-loss path. The stable `WorkerController`
interface and possession wire profile do not change.

## User Stories

1. As a Claimant, I want the browser to select an exact local control function, so that a runtime
   log or bootloader port cannot receive a Work Lease.
1. As a Worker owner, I want runtime evidence to remain receive-only, so that observing or exporting
   diagnostics cannot authorize mining.
1. As a firmware operator, I want flashing and application control to have explicit reacquisition,
   so that an expected USB re-enumeration cannot be mistaken for device continuity or drift.
1. As a privacy-conscious owner, I want challenge credentials confined to the control path and
   volatile memory, so that they never reach logs, evidence, telemetry, or ordinary pool settings.
1. As a conformance implementer, I want versioned fixtures shared through the published package, so
   that browser, simulator, host tooling, and Reference Firmware execute the same contract.
1. As a hardware verifier, I want each terminal and interruption scenario to prove exact Mining
   Baseline restoration independently, so that Ticket 23 closes from real evidence rather than a
   simulator claim.

## Implementation Decisions

- Keep `WorkerController` as the deep module interface used by the headless client and Web
  Component. Physical USB selection, descriptors, transfers, reacquisition, and disconnect
  detection stay behind its production adapter.
- Preserve strict Controller 0.1, Controller 0.2, and Worker USB 0.1 compatibility profiles. Publish
  Controller 0.3 rather than widening any existing strict shape.
- Publish `bwg-worker-usb/0.2` with the same exact physical descriptor as USB 0.1, but widen the
  vendor control function from Controller-only frames to possession-or-Controller frames.
- Publish `bwg-worker-possession/0.1` as a separate pre-admission profile on that USB 0.2 control
  function. Controller 0.3 Work Lease commands retain Controller 0.2 semantics.
- Keep Update Authority and Work Lease Authority verification separate. Publish a strict compact
  JWS profile inside the existing opaque Work Lease `authorization` field rather than widening or
  versioning Controller 0.3.
- Bind Work Lease authorization to the complete authorizationless canonical request. Start binds
  Challenge ID and all Stratum/deadline terms; Renew also binds the retained active Challenge ID.
- Give every Work Lease Authority key a durable monotonic authorization sequence. Firmware
  atomically persists its per-key accepted high-water mark before any Start or Renew effect and
  rejects non-increasing values across restoration and reboot. Sequence state is metadata-only and
  separate from ordinary settings and challenge credentials. The closed sequence domain is
  canonical unsigned 64-bit decimal `1..=18446744073709551615` without a leading zero; allocator
  exhaustion fails closed.
- Keep the compact JWS payload closed to operation, request digest, and canonical decimal sequence;
  add only the current control-session digest, and pin issuer, audience, role, and profile through
  the `kid`-selected trust configuration. Restrict `kid` to
  `[A-Za-z0-9_-]{1,32}` ASCII bytes and operation to exactly `start` or `renew`. Derive the maximum
  header/payload/signature size from the maximum key ID, five-byte operation, two digests, unsigned
  64-bit sequence, and fixed Ed25519 signature, and prove it remains within 512 bytes.
- Preserve the `WorkerController` interface. Add a separate authorization-context interface that
  proves a fresh Device Identity-bound local possession exchange before Authority Start/resume and
  shares only a domain-separated transcript digest with the Authority. Firmware invalidates that
  context after 60 unused local monotonic seconds, after any restoration/continuity loss, or when
  no matching lease remains.
- Keep private signing keys outside repositories and processes that only verify. Development
  deployment tooling may create protected local keys, but committed fixtures and configuration
  contain public JWKs and signed public artifacts only.
- Use a vendor-specific WebUSB function for control so the browser can claim an exact interface
  rather than probing or writing an ambiguous CDC port. Keep one distinct CDC function for
  receive-only evidence.
- Keep controller request/response payloads bounded, strict, correlated, and metadata-only on
  failure. The transport profile may carry the existing UTF-8 JSON frame representation over USB
  bulk transfers but never shares an endpoint with logs.
- Treat ROM bootloader USB Serial/JTAG and application TinyUSB as separate enumeration identities
  of one admitted physical Worker. Neither a device-node name nor one enumeration identity proves
  physical continuity.
- Establish physical continuity only from a fresh Device Identity possession proof. Pairing,
  accounts, Control Grants, and hardware attestation remain outside this local proof.
- Require a direct browser user gesture before device permission. No automatic discovery, network
  scan, stale port reuse, or write to an unadmitted function is permitted.
- Restore the Mining Baseline locally before reporting controller disconnect, continuity loss,
  reboot recovery, or any terminal Work Lease state.
- Represent identity drift or lost original-Worker contact as `restoration_pending`; never project
  a confirmed baseline or terminal completion until the original physical Worker is reacquired and
  supplies restoration proof.
- Let this repository own profiles, browser adapters, fixtures, simulator behavior, and parent
  orchestration. Let `bitaxe-esp-miner` own TinyUSB implementation, volatile credential handling,
  device-local restoration, and native hardware evidence under its task/evidence policies.
- Preserve Controller 0.1, Controller 0.2, and Worker USB 0.1 fixtures and exports for existing
  consumers. Controller 0.3 with USB 0.2 and possession becomes the only profile eligible for the
  first real Reference Firmware claim.

## Threat Model

- A malicious or confused client selects the evidence function, bootloader port, or another USB
  device and attempts to send controller frames.
- Device logs contain JSON-shaped or attacker-influenced bytes intended to look like commands or
  responses.
- A device disconnects, reboots, changes enumeration identity, resets its monotonic clock, or loses
  control continuity while challenge work is active.
- A backend supplies a forged or overlong grant, reuses an old Lease ID, changes Stratum terms under
  a valid authorization, or attempts to persist challenge credentials as ordinary settings.
- A capability-signing key is reused to authorize Work Leases, a Work Lease key signs firmware
  capability, or a stale/retired key remains trusted outside an explicit overlap window.
- A previously accepted signed Start or Renew is replayed after restoration, process interruption,
  or firmware reboot, or work begins before its accepted-sequence high-water mark is durable.
- A valid but never-presented authorization is withheld beyond its local possession context, moved
  into another context, or presented after restoration/reboot with a sequence above the persisted
  high-water mark.
- One possession request is replayed against a different Device Identity in an attempt to derive
  the same authorization context.
- A replacement application function appears after flashing but does not belong to the admitted
  physical Worker or does not expose the exact signed Reference Firmware capability.
- Evidence, logs, manifests, browser errors, telemetry, or public projections accidentally contain
  Wi-Fi, pool, authorization, USB identity, account, payout, or challenge credential material.

## Testing Decisions

- Keep pure Worker Controller lifecycle vectors independent from physical transport vectors.
- Keep strict Controller 0.2 and `bwg-worker-usb/0.1` fixtures unchanged. Add Controller 0.3
  capability/request/response fixtures plus USB 0.2 function/reacquisition fixtures.
- Add strict Local Device Possession Proof vectors for initial admission, same-key reacquisition,
  replay, replacement-key rejection, changed bindings, weak keys, and arbitrary-signing attempts.
- Add strict Work Lease authorization vectors for complete Start/Renew binding, tampering, wrong
  authority role, 512-byte representation bounds, monotonic sequence allocation, replay before and
  after restoration/reboot, same-nonce/different-Device-Identity isolation,
  withheld/cross-context/late presentation, 60-second local context boundaries, crash boundaries
  around high-water persistence, overlap rotation, retirement, and byte-level private-key/input
  privacy.
- Prove the evidence function cannot parse commands and the control function emits no logs or
  uncorrelated bytes.
- Exercise wrong function, wrong device, ambiguous selection, bootloader selection, interface
  disappearance, re-enumeration, response loss, disconnect, reboot, and continuity loss.
- Verify byte-level absence of credentials and operational identity from evidence, logs, errors,
  manifests, browser-visible state, and committed projections.
- Require Reference Firmware to consume the published package fixtures rather than a locally
  rewritten copy or Git submodule.
- Run real Chromium tests through the production WebUSB adapter and real-process host tests through
  the firmware repository's native USB/evidence tooling before hardware use.
- Use the firmware repository's detector, protected evidence root, exact package, recovery,
  restoration, cleanup, retry, and redaction gates for every real-device attempt.

## Out of Scope

- External USB PHY hardware, direct UART, pins, pads, probes, jumpers, or electrical modification.
- Remote Device Relay, Device Identity pairing, fleet management, or persistent Control Grants.
  Local proof of possession by an already selected Device Identity is in scope.
- A remote authority administration API, device registry, shared Update/Lease signing key, or
  committed production private key.
- General-purpose firmware console input, remote shell behavior, arbitrary USB writes, or log
  streaming through the control function.
- Changing Gate Authority accounting, Pool Adapter BIP 23 admission, Reward Policy, Gate Pass
  issuance, or Relying Service behavior.
- Claiming real-hardware success from descriptor tests, simulators, or software-only firmware
  verification.

## Parent

This child effort supplies the transport and cross-repository evidence required to close
[BWG Core Ticket 23](../bwg-core/issues/23-real-bitaxe-restoration-evidence.md) without reopening or
renumbering resolved Tickets 21 and 22.
