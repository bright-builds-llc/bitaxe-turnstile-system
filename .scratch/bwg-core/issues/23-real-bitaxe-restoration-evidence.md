# 23: Prove Work Lease restoration on real Bitaxe hardware

**What to build:** Real Bitaxe evidence proves that bounded mainnet-capable challenge work can run through Reference Firmware and restore the exact Mining Baseline across every terminal and interruption path.

**Blocked by:** 18: Admit only exact BIP 23-valid mainnet jobs; 20: Aggregate Workers and fail over equivalent Pool Offers; 22: Onboard Bitaxe with settings-preserving Reference Firmware; child effort `bwg-worker-usb-separation` through Ticket 07.

**Status:** ready-for-agent

- [ ] The firmware repository consumes the shared Controller 0.3, Worker USB 0.2, Local Device
  Possession, and Work Lease Authorization conformance profiles and fixtures, separate authority
  trust configurations, and exact signed Ultra 205 capability artifact.
- [ ] Exact-device admission and safe hardware state are proven before each effectful attempt.
- [ ] Completion, Pause, terminal Cancel, expiry, disconnect, reboot, and uncertain-time cases each end challenge mining.
- [ ] Mining Baseline restoration is independently confirmed without exposing Wi-Fi or pool credentials.
- [ ] Challenge credentials never persist as ordinary pool configuration.
- [ ] Previously accepted Work Lease authorizations remain rejected across restoration and reboot
  using metadata-only durable per-key sequence state.
- [ ] Withheld, expired-context, and cross-possession Work Lease authorizations fail before mining;
  only the privacy-safe control-session digest reaches the Gate Authority.
- [ ] The same possession request answered by another Device Identity derives a different context
  and cannot reuse the first Worker's authorization.
- [ ] Mainnet use follows the established per-job BIP 23 and Reward Policy guardrails rather than a regtest stage gate.
- [ ] Evidence records source identity, commands, safety, privacy, cleanup, outcome, and residual risks through the firmware repository's native workflow.

## Transport prerequisite

[`bwg-worker-usb-separation`](../../bwg-worker-usb-separation/spec.md) must first publish and compose
the separated application control/evidence profiles. Ticket 23 consumes that child effort's exact
Controller 0.3, Worker USB 0.2, Local Device Possession, and Work Lease Authorization fixtures,
separate authority trust configurations, signed Ultra 205 capability, Reference Client adapter,
Reference Firmware adapter, and cross-repository hardware evidence. It does not send Work Lease
commands over the receive-only 0.1 runtime log transport.
