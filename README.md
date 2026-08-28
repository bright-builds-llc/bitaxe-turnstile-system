# Bitcoin Work Gate Protocol

<!-- bright-builds-rules-readme-badges:begin -->

<!-- Managed upstream by bright-builds-rules. If this badge block needs a fix, open an upstream PR or issue instead of editing the downstream managed block. Keep repo-local README content outside this managed badge block. -->

[![GitHub Stars](https://img.shields.io/github/stars/bright-builds-llc/bitaxe-turnstile-system)](https://github.com/bright-builds-llc/bitaxe-turnstile-system)
[![License](https://img.shields.io/github/license/bright-builds-llc/bitaxe-turnstile-system?style=flat-square)](./LICENSE)
[![Bright Builds: Rules](https://raw.githubusercontent.com/bright-builds-llc/bright-builds-rules/main/public/badges/bright-builds-rules-flat.svg)](https://github.com/bright-builds-llc/bright-builds-rules)

<!-- bright-builds-rules-readme-badges:end -->

Bitcoin Work Gate Protocol (`BWG`) is an open, MIT-licensed protocol for requiring fresh Bitcoin-productive work before authorizing a protected website or service action.

BWG provides resource-backed abuse resistance. It does not claim to prove humanity, uniqueness, identity, or ownership of a particular mining device.

## Status

The repository contains the protocol language, accepted architectural decisions, and an executable BWG Core spine. PostgreSQL separately persists Gate Authority accounting and crash-recoverable issuance plus Reference Relying Service Pass Consumption, Redemption, execution, and durable Outcome Lookup.

## Development

The acceptance harness starts PostgreSQL in ephemeral Docker containers, starts both HTTP interfaces on ephemeral local ports, and exercises them only through public role interfaces. Local verification therefore requires a running Docker daemon.

```sh
bun run test
bun run verify
```

`bun run verify` checks Rust formatting, linting, all targets, tests, and the managed Bright Builds repository rules.

The framework-independent browser SDK is exported as the package subpath `bwg-core/headless`; run
`bun run build:browser` to emit its self-hostable ESM and declarations, then see
[`docs/protocol/bwg-0.1-headless-client.md`](docs/protocol/bwg-0.1-headless-client.md).

The versioned local Worker Controller and USB contract, simulator, and cross-repository fixtures are
documented in
[`docs/protocol/bwg-0.1-worker-controller.md`](docs/protocol/bwg-0.1-worker-controller.md).
The separated real-firmware evolution is documented in
[`docs/protocol/bwg-0.2-worker-controller.md`](docs/protocol/bwg-0.2-worker-controller.md) and
[`docs/protocol/bwg-worker-usb-0.1.md`](docs/protocol/bwg-worker-usb-0.1.md).

The accountless settings-preserving Reference Firmware installation and rollback profile is
documented in
[`docs/protocol/bwg-0.1-bitaxe-onboarding.md`](docs/protocol/bwg-0.1-bitaxe-onboarding.md).

The SolidJS custom element is exported as `bwg-core/component` for plain HTML, inline, modal, and
full-page integrations; see
[`docs/protocol/bwg-0.1-web-component.md`](docs/protocol/bwg-0.1-web-component.md).
Elevated work and Authority-signed changed terms use the attested WebAuthn trusted-origin receipt
profile described in
[`docs/protocol/bwg-0.1-trusted-consent.md`](docs/protocol/bwg-0.1-trusted-consent.md).

The Rust Stratum V1 Pool Adapter module forwards standard Worker traffic, durably records accepted
events before Worker acknowledgement, and retries Gate Authority delivery from its context-local
PostgreSQL outbox; see
[`docs/protocol/bwg-0.1-stratum-v1-proxy.md`](docs/protocol/bwg-0.1-stratum-v1-proxy.md).
The pinned out-of-process Hydra/Bitcoin Core acceptance profile and reproducible runner are
documented in
[`docs/protocol/bwg-0.1-hydra-solo-integration.md`](docs/protocol/bwg-0.1-hydra-solo-integration.md).
The mandatory mainnet Reward Policy and BIP 23 pre-work gate is specified and exercised in
[`docs/protocol/bwg-0.1-mainnet-job-admission.md`](docs/protocol/bwg-0.1-mainnet-job-admission.md).
The network-block fast path and composed outage/reorg evidence are documented in
[`docs/protocol/bwg-0.1-independent-block-submission.md`](docs/protocol/bwg-0.1-independent-block-submission.md).

## Principles

- Every qualifying hash searches a valid Bitcoin block candidate.
- The protocol is hardware-neutral, with a Bitaxe-first Reference Client.
- Equivalent risk requires equivalent normalized expected work.
- Gate Passes are short-lived, single-use, and proof-of-possession bound.
- Mining, gating, Worker Management, and identity remain separate bounded contexts.
- Claimant consent, payout disclosure, privacy minimization, and client safety ceilings are mandatory.
- Implementations are independently deployable and tested through executable Conformance Profiles.

## Design documents

- [Context map](./CONTEXT-MAP.md)
- [V1 onboarding](./docs/design/v1-onboarding.md)
- [V1 lifecycle](./docs/design/v1-lifecycle.md)
- [V1 policy defaults](./docs/design/v1-policy-defaults.md)
- [V1 pool integration](./docs/design/v1-pool-integration.md)
- [V1 Worker Management](./docs/design/v1-worker-management.md)
- [V1 technology](./docs/design/v1-technology.md)
- [Release scope](./docs/design/release-scope.md)
- [Core MVP success criteria](./docs/design/core-mvp-success-criteria.md)
- [Threat model](./docs/design/threat-model.md)
- [Repository ownership](./docs/design/repository-ownership.md)
- [Digital Energy language](./docs/design/digital-energy-language.md)
- [Deferred v2 areas](./docs/design/deferred-v2.md)
- [Implementation research](./docs/design/implementation-research.md)
- [Architectural decisions](./docs/adr/)
- [BWG/0.1 OpenAPI contract](./openapi/bwg-0.1.json)
- [BWG/0.1 recovery matrix](./docs/protocol/bwg-0.1-recovery-matrix.md)
- [Data-governance open questions](./docs/design/data-governance-open-questions.md)
- [Original project brief](./initial-prompt.md)

## License

Project-authored protocols, services, SDKs, adapters, and firmware additions are licensed under the [MIT License](./LICENSE). Replaceable external pool engines retain their own disclosed licenses.
