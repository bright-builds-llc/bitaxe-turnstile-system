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

The repository is currently in collaborative domain and architecture design. It contains the protocol language, accepted architectural decisions, v1 product defaults, and deferred design areas; implementation planning follows after the design interview closes.

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
- [Original project brief](./initial-prompt.md)

## License

Project-authored protocols, services, SDKs, adapters, and firmware additions are licensed under the [MIT License](./LICENSE). Replaceable external pool engines retain their own disclosed licenses.
