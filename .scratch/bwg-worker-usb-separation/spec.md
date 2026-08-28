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
descriptor digest. USB serial, VID/PID, and enumeration identity remain non-authoritative hints.

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
