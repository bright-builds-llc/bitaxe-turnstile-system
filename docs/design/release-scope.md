# Release Scope

## BWG Core MVP

- Rust modular Gate Authority and PostgreSQL append-only work ledger.
- Mainnet-capable transparent Stratum V1 Pool Adapter proxy in front of pinned Hydra.
- Public OpenAPI, internal Protobuf, Authority Descriptor, and constrained JWS/DPoP Gate Pass profile.
- Executable Client, Gate Authority, Pool Adapter, and Relying Service Conformance Profiles.
- Framework-agnostic SolidJS Web Component and headless SDK.
- Accountless, app-free local Bitaxe onboarding with signed Reference Firmware, settings preservation, optional local encrypted migration backup, and safe Mining Baseline restoration.
- Advanced standard-Stratum path for non-Bitaxe Workers.
- One reference Relying Service protecting account creation with the Standard Work Requirement.
- Exact target-derived Credited Work, Equivalent Binary-Zero Work, Verified Progress, Activity Estimate, Work Consent, Pool Offer, and direct Reward Policy UX.
- Short-lived proof-of-possession Gate Pass Redemption with idempotent, outcome-backed action execution.

## Worker Management v1

- Passwordless Identity and Access with passkeys, email code, and NIP-46/NIP-98 Nostr authentication.
- Device Identity, local Pairing Ceremony, Owner Grants, transfer, reclamation, and user-held recovery.
- WebSocket/Protobuf Device Relay and remote Worker Authorization.
- Narrow remote management API, SolidJS web console, and Capacitor mobile applications.
- Minimal bounded telemetry and signed OTA with local owner recovery.

Worker Management consumes published BWG and Worker Controller contracts. It does not change BWG Core work accounting, Gate Pass semantics, or hardware neutrality.
