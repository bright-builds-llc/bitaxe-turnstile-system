# Implementation Research

The product and architecture decisions are closed for BWG Core planning. These bounded questions require prototypes or source-level validation during implementation:

1. Design and upstream, where practical, the Hydra/P2Pool hook that assembles each exact job candidate and requires pre-work BIP 23 proposal acceptance before `mining.notify`.
2. Verify pinned Hydra solo/direct-payout behavior, Reward Policy output construction, variable-difficulty limits, stale-job handling, and mainnet block-submission latency end to end.
3. Specify the fixed-width binary and decimal JSON encodings for 256-bit target-derived work, including overflow, saturation, and canonical test vectors.
4. Select the mandatory browser DPoP key algorithm and verify WebCrypto, server-library, Capacitor, and NIP-46 interoperability across supported platforms.
5. Define the USB capability, provisioning, settings-preservation, schema-migration, local backup, and redacted verification protocol for Reference Firmware.
6. Verify fully specified Ed25519 JOSE support, JWKS rotation, and hosted non-exportable signing-key options.
7. Prototype the SolidJS Web Component across Chromium Web Serial permission, trusted-origin confirmation, accessibility, recovery, and non-Bitaxe advanced flows.
8. **Resolved:** concrete record-retention, deletion, export, audit, and incident-response operations are defined in [`bwg-0.1-data-governance.md`](../protocol/bwg-0.1-data-governance.md) with executable evidence under `.scratch/bwg-data-governance/`.
9. Threat-review the mainnet pool deployment and run deterministic equivalents continuously without converting regtest into an environment stage gate.
