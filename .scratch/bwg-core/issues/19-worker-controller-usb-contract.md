# 19: Publish the Worker Controller and USB contract with a simulator

**What to build:** A versioned cross-repository contract and simulated device let the browser client discover a local Worker, execute bounded Work Leases, and observe safe Mining Baseline restoration without depending on firmware internals.

**Blocked by:** 08: Pause, cancel, expire, and resume safely; 10: Obtain Work Consent through the headless client.

**Status:** ready-for-agent

- [ ] Capability discovery reports board, firmware, protocol, and preservation compatibility without secrets.
- [ ] The contract covers lease start, renewal, status, Pause, Cancel, expiry, lost continuity, reboot, and restoration confirmation.
- [ ] Monotonic deadline behavior is observable and independent of accurate device wall time.
- [ ] The simulator implements every positive and negative contract scenario.
- [ ] The headless client uses the public Worker Controller interface rather than simulator-specific hooks.
- [ ] Credentials, Wi-Fi, pool settings, and private keys are absent from public diagnostics.
- [ ] The shared fixtures can be consumed by both this repository and the firmware repository.
