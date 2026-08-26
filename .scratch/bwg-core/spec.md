# BWG Core MVP Specification

Status: ready-for-agent

## Problem Statement

Websites and services need a transparent way to impose a measurable resource cost on abuse without pretending to prove that a requester is human, unique, identified, or the owner of a particular device. Existing CAPTCHA-style controls optimize for human classification, commonly degrade privacy and accessibility, and do not let a service price a Protected Action in useful Bitcoin work.

Claimants who already operate Bitcoin mining hardware need a safe, understandable way to direct bounded work toward a Protected Action without surrendering permanent control of their Workers, exposing unrelated identity or payout data, or wasting hashes on synthetic puzzles. A first-time Bitaxe owner needs an accountless, app-free path that preserves ordinary mining settings and restores them after the gate completes or connectivity fails. Owners of non-Bitaxe hardware need an open standard rather than a vendor lock.

Relying Services need a small integration surface that can be self-hosted or delegated to a trusted Gate Authority. Pool operators need BWG integration to remain outside consensus-facing mining logic. Implementers need exact work accounting, explicit trust boundaries, executable Conformance Profiles, and failure behavior that cannot silently mint authorization, double-credit work, extend mining, or lose a rare mainnet block reward.

## Solution

BWG Core provides a hardware-neutral Bitcoin Work Gate Protocol for requiring fresh Bitcoin-Productive Work before authorizing one Protected Action. A Relying Service backend creates a Work Challenge from a versioned Action Policy and binds it to an opaque Action Reference plus an ephemeral Claimant proof-of-possession key. The challenge discloses an exact Work Requirement, one or more approved Pool Offers, a Reward Policy, lifecycle limits, and client safety requirements.

A Claimant selects compatible Workers and a Pool Offer, reviews exact expected hashes plus Equivalent Binary-Zero Work, chooses a per-challenge Payout Destination or explicit beneficiary, and provides Work Consent. Workers mine valid Bitcoin block candidates through standard Stratum V1. A transparent Pool Adapter proxy associates challenge-scoped Work Sessions with the Work Challenge, observes assigned targets and accepted pool responses, and delivers durable Accepted Work Events to the Gate Authority with at-least-once semantics.

The Gate Authority computes integer Credited Work from server-assigned targets, deduplicates events and shares, and exposes Verified Progress through a public HTTPS JSON interface with Server-Sent Events. When the Work Requirement is satisfied, all Work Leases end, participating Workers restore their Mining Baselines, and the Authority issues a short-lived JWS Gate Pass bound to the Relying Service, Action Reference, and Claimant key. The Claimant redeems that pass using DPoP; the Relying Service atomically consumes it and creates an idempotent Redemption Record for the Protected Action.

The reference deployment is a modular Rust Gate Authority backed by PostgreSQL, an MIT Rust Stratum V1 Pool Adapter proxy in front of a pinned, separately licensed Hydra engine, a framework-agnostic SolidJS Web Component plus headless client, and a reference account-creation integration. Real Worker integration may use mainnet from the outset, but each exact mainnet job must pass independent Reward Policy checks and BIP 23 proposal acceptance before release.

## User Stories

### Claimant and consent

1. As a Claimant, I want to know that BWG proves expended work rather than humanity, so that I understand what the gate does and does not establish.
2. As a Claimant, I want the gate to identify the Protected Action before mining starts, so that I know what my work will authorize.
3. As a Claimant, I want the Work Requirement shown as exact expected hashes, so that the authoritative cost is unambiguous.
4. As a Claimant, I want the Work Requirement shown as Equivalent Binary-Zero Work, so that I can relate the cost to intuitive Bitcoin mining difficulty.
5. As a Claimant, I want the display to distinguish cumulative gate work from a literal per-share leading-zero target, so that the analogy does not misrepresent the protocol.
6. As a Claimant, I want an estimated duration for my selected Workers, so that I can decide whether to proceed.
7. As a Claimant, I want estimated energy use when trustworthy telemetry is available, so that I can understand likely physical cost without treating it as authoritative work accounting.
8. As a Claimant, I want the Reward Policy and every Payout Destination disclosed before mining, so that reward allocation cannot be hidden or changed later.
9. As a Claimant, I want to choose among approved Pool Offers when several are available, so that pool competition can improve terms without weakening the Work Requirement.
10. As a Claimant, I want an explicit user-initiated Start action, so that a page cannot begin mining merely because it loaded.
11. As a Claimant, I want client-controlled work ceilings, so that a Relying Service cannot commandeer more work than I permit.
12. As a Claimant, I want consequential work confirmed on a trusted origin, so that an embedding website cannot counterfeit Elevated work terms.
13. As a Claimant, I want Verified Progress separated from an Activity Estimate, so that animated activity is never confused with accepted work.
14. As a Claimant, I want to Pause work without losing Verified Progress before challenge expiry, so that temporary interruption is recoverable.
15. As a Claimant, I want explicit Cancel Challenge to explain that progress becomes unusable, so that terminal cancellation is deliberate.
16. As a Claimant, I want closing a tab or losing connectivity to behave like Pause, so that an accidental interruption does not silently discard progress.
17. As a Claimant, I want the Gate Pass to expire quickly and remain single-use, so that completed work cannot become a banked authorization.
18. As a Claimant, I want backend failure after accepted Redemption handled idempotently, so that I do not mine again because the website timed out.
19. As a Claimant, I want outcome lookup to reveal only an already accepted action result, so that it cannot reauthorize or restart the Protected Action.
20. As a Claimant, I want an honest unavailable outcome when BWG cannot verify work, so that fallback is not misrepresented as successful proof.

### Worker choice and Bitaxe onboarding

21. As a Claimant, I want any compliant Bitcoin Worker to be eligible, so that BWG does not require one manufacturer or device class.
22. As a Bitaxe owner, I want a guided Reference Client path, so that the most supported first experience is simple.
23. As a non-Bitaxe owner, I want short-lived standard Stratum V1 configuration, so that my compatible Worker can participate without custom firmware.
24. As a first-time Bitaxe owner, I want to complete a gate without a Bright Builds account, so that account creation cannot depend circularly on an existing account.
25. As a first-time Bitaxe owner, I want to complete a gate without installing a mobile app, so that first use stays within the website and connected hardware.
26. As a Bitaxe owner, I want firmware and board capabilities detected before flashing, so that the client does not guess compatibility.
27. As a Bitaxe owner, I want only signed compatible Reference Firmware offered, so that remote distribution cannot substitute an arbitrary image.
28. As a Bitaxe owner, I want existing settings preserved by default, so that onboarding does not erase ordinary mining configuration.
29. As a Bitaxe owner, I want any credential-bearing Migration Backup encrypted locally, so that Wi-Fi and pool secrets never reach BWG services.
30. As a Bitaxe owner, I want post-reboot retention verified through redacted evidence, so that configuration can be checked without exposing credentials.
31. As a Bitaxe owner, I want onboarding to stop when preservation or recovery cannot be established, so that flashing fails safely.
32. As a Worker owner, I want challenge credentials kept separate from ordinary pool settings, so that temporary work never becomes my persistent configuration.
33. As a Worker owner, I want a bounded Work Lease, so that challenge mining cannot continue indefinitely.
34. As a Worker owner, I want reboot or uncertain device time to terminate the Work Lease, so that clock failure cannot extend mining.
35. As a Worker owner, I want the Mining Baseline restored after completion, Pause, cancellation, expiry, or lost continuity, so that normal mining resumes safely.
36. As a Worker owner, I want multiple Workers to contribute to one Work Challenge, so that I can aggregate my available hashpower.
37. As a Worker owner, I want a failed Worker replaced without restarting the Work Challenge, so that hardware or network failure does not erase accepted work.
38. As a Worker owner, I want automatic pool failover limited to pre-consented equivalent terms, so that failover cannot silently redirect rewards or hashpower.
39. As a Worker owner, I want changed economic or privacy terms to require new Work Consent, so that resilience does not override consent.
40. As a Worker owner, I want challenge mining to stop when the Gate Pass is issued, so that access never implies continued mining.

### Relying Service integration

41. As a Relying Service administrator, I want to register versioned Action Policies, so that equivalent Protected Actions receive auditable Gate Policy.
42. As a Relying Service administrator, I want configurable Light, Standard, Elevated, and exact Work Requirements, so that policy can evolve without a protocol revision.
43. As a Relying Service administrator, I want account creation to default to Standard work, so that the reference integration has a concrete starting policy.
44. As a Relying Service administrator, I want later policy changes isolated from active challenges, so that issued requirements never mutate.
45. As a Relying Service administrator, I want to configure approved Pool Offers and fallback methods, so that operational and Abuse Policy choices remain mine.
46. As a Relying Service administrator, I want BWG failure distinguishable from an Abuse Policy waiver, so that authorization records remain truthful.
47. As a Relying Service backend, I want challenge issuance restricted to authenticated server calls, so that browsers cannot lower work or change rewards.
48. As a Relying Service backend, I want scoped rotatable service credentials, so that hosted integration is simple without exposing secrets to browser code.
49. As a Relying Service backend, I want a public challenge descriptor safe for the browser, so that presentation does not reveal server credentials or action payloads.
50. As a Relying Service backend, I want the Gate Pass audience and Action Reference fixed, so that work cannot authorize another service or action.
51. As a Relying Service backend, I want JWS verification through configured Authority keys, so that I can validate delegated authorization locally.
52. As a Relying Service backend, I want DPoP-bound Redemption, so that copying a Gate Pass is insufficient to use it.
53. As a Relying Service backend, I want atomic pass consumption, so that concurrent requests cannot redeem one pass twice.
54. As a Relying Service backend, I want a durable Redemption Record, so that exact-action retries return one stable outcome.
55. As a Relying Service developer, I want generated SDKs from the public contract, so that integration is consistent across implementation languages.
56. As a Relying Service developer, I want a framework-agnostic Web Component, so that I can integrate BWG without adopting SolidJS.
57. As a Relying Service developer, I want inline, modal, and full-page presentation modes, so that the gate fits different product experiences.
58. As a Relying Service developer, I want a headless client, so that I can build a conforming custom user interface.
59. As a Relying Service developer, I want typed lifecycle events, so that my application can react without accessing private keys or internal state.
60. As a Relying Service user, I want configured alternative authorization methods shown when no compatible Worker is available, so that the service can provide an accessible fallback.

### Gate Authority and accounting

61. As a Gate Authority operator, I want exact integer work arithmetic, so that independent implementations agree without floating-point difficulty drift.
62. As a Gate Authority operator, I want Credited Work derived from the server-assigned share target, so that Workers cannot self-report hashes or receive extra credit for luck.
63. As a Gate Authority operator, I want Accepted Work Events delivered at least once with stable identifiers, so that transport failure does not lose progress.
64. As a Gate Authority operator, I want event and share deduplication in one transaction, so that retries cannot double-credit work.
65. As a Gate Authority operator, I want an append-only work ledger plus cumulative projection, so that progress is fast while accounting remains auditable.
66. As a Gate Authority operator, I want pass issuance durably pending at threshold crossing, so that a process crash cannot strand completed work.
67. As a Gate Authority operator, I want challenge, lease, DPoP, and Gate Pass deadlines enforced consistently, so that stale artifacts fail closed.
68. As a Gate Authority operator, I want work received after challenge expiry excluded from authorization, so that expiry has deterministic meaning.
69. As a Gate Authority operator, I want already Credited Work retained during Pause until challenge expiry, so that reconnection does not require replaying accepted work.
70. As a Gate Authority operator, I want explicit federation keys and Authority Descriptors, so that discovery never implies trust.
71. As a Gate Authority operator, I want pairwise Claimant keys and opaque Action References, so that BWG does not become a cross-site identity system.
72. As a Gate Authority operator, I want only bounded non-identifying operational records retained, so that replay protection does not become indefinite surveillance.
73. As a Gate Authority operator, I want one modular deployable with a small public interface, so that operational complexity stays below premature microservices.
74. As a self-hoster, I want the same interfaces as the hosted deployment, so that I can collapse trust boundaries without forking the protocol.
75. As a self-hoster, I want a versioned well-known Authority Descriptor, so that clients and Relying Services can configure my deployment consistently.

### Mining Pool and Pool Adapter

76. As a Pool Adapter implementer, I want BWG concerns separated from Stratum and pool internals, so that another pool engine can be supported through an adapter.
77. As a Pool Adapter implementer, I want challenge-scoped credentials and unique extranonce space, so that accepted work maps to exactly one Work Session.
78. As a Pool Adapter implementer, I want to observe assigned targets and accepted responses without altering jobs, so that work accounting remains a transparent layer.
79. As a Pool Adapter implementer, I want to persist an Accepted Work Event before acknowledging the Worker, so that an acknowledged share cannot disappear from gate progress.
80. As a Pool Adapter implementer, I want duplicate and cross-session submissions rejected, so that one result cannot fund several challenges.
81. As a Pool Adapter implementer, I want gRPC and Protobuf for event delivery, so that the service-to-service stream is typed and versioned.
82. As a pool operator, I want Hydra pinned and isolated as a separately licensed process, so that BWG's MIT components do not misstate external licensing.
83. As a pool operator, I want Hydra to remain unaware of Protected Actions, so that application authorization cannot spread into mining logic.
84. As a pool operator, I want the first integration to use solo-style direct payouts, so that v1 avoids custody, balances, thresholds, and PPLNS accounting.
85. As a pool operator, I want challenge payout instructions validated before job release, so that a rare block cannot pay an undisclosed destination.
86. As a pool operator, I want the exact candidate block accepted in BIP 23 proposal mode before mainnet work begins, so that Workers do not hash an invalid template.
87. As a pool operator, I want missing or inconclusive proposal validation to fail closed, so that availability pressure cannot bypass mainnet safety.
88. As a pool operator, I want network-valid block submission isolated from gate accounting, so that authorization infrastructure cannot delay a block.
89. As a pool operator, I want stale or reorganized reward outcomes separated from Gate Pass validity, so that performed work remains recognized even when reward outcomes change.
90. As a pool operator, I want variable-difficulty shares frequent enough for useful progress when practical, so that Bitaxe-class users receive responsive feedback.

### Implementers, auditors, and maintainers

91. As a protocol implementer, I want separate Client, Gate Authority, Pool Adapter, and Relying Service Conformance Profiles, so that I can claim only the roles I actually support.
92. As a protocol implementer, I want canonical positive and negative vectors, so that work, signature, expiry, replay, and lifecycle semantics are portable.
93. As a protocol implementer, I want `BWG/0.x` during development and strict major-version security boundaries, so that experimentation cannot silently change stable semantics.
94. As a protocol implementer, I want optional capabilities negotiated explicitly, so that compatible extensions do not fragment the core protocol.
95. As a security auditor, I want configured trust relationships documented, so that federated trust is not marketed as global trustlessness.
96. As a security auditor, I want privacy tests that prohibit Account Identity, Device Identity, action payload, network secrets, and unrelated payout data from crossing context seams, so that minimization is executable.
97. As a security auditor, I want malformed payout, stale job, duplicate event, expired pass, lost continuity, and outage scenarios covered, so that critical failures have observable safe outcomes.
98. As a maintainer, I want domain logic as data-in, data-out functions, so that accounting and lifecycle decisions are testable without infrastructure.
99. As a maintainer, I want persistence, time, randomness, signing, networking, and pool integration behind thin adapters, so that complex effects remain local.
100. As a maintainer, I want source, protocol version, commit, and build provenance visible in public applications, so that deployed behavior can be traced.
101. As an open-source adopter, I want project-authored code under MIT and external engine licenses disclosed, so that I can fork and deploy without licensing ambiguity.
102. As an open-source adopter, I want implementation decisions expressed through small interfaces and executable fixtures, so that replacing an adapter does not require understanding the whole system.

## Implementation Decisions

### Scope and ownership

- This specification covers BWG Core MVP only: the Gate Authority, public protocol, Pool Adapter proxy, conformance harness, Web Component and headless client, reference account-creation integration, standard-Stratum Worker path, and the Reference Firmware contract needed for accountless local Bitaxe use.
- Worker Management v1 remains a separate later release. Identity and Access, Device Relay, persistent pairing, Owner Grants, mobile applications, remote fleet control, telemetry history, and remote OTA are not implementation dependencies for the Core MVP.
- The gate repository owns the Gate Authority, protocol contracts, Pool Adapter SDK and reference proxy, browser client, reference integration, operator configuration, and conformance fixtures.
- Reference Firmware implementation remains owned by the firmware repository. BWG Core owns only the interoperable Worker Controller/USB contract and the acceptance expectations that the firmware implementation must satisfy.
- Hydra, P2Pool, and Bitcoin Core remain external replaceable processes under their own licenses.

### Module shape and seams

- The Gate Authority is one modular Rust deployable with a small public interface. Its implementation may contain internal modules, but callers and tests interact through published HTTP, SSE, gRPC, signing, and configuration interfaces rather than internal collaborators.
- Gate lifecycle and work accounting form a functional core. They accept parsed domain values and return explicit decisions, state transitions, work increments, and effects to perform.
- HTTP, PostgreSQL, clocks, randomness, signing keys, event delivery, and operator configuration are imperative-shell adapters around that core.
- The transparent Pool Adapter proxy is a separate process because its public Stratum endpoint, network failure mode, licensing adjacency, and deployment locality are genuine seams.
- The Web Component and headless client share one lifecycle implementation. The custom element is an adapter over the headless interface rather than a second domain implementation.
- The reference Relying Service uses the same published challenge and Redemption interfaces expected of third parties.
- The Gate Authority and Relying Service own separate PostgreSQL schemas, forward-only migrations, and repository ports. A reference deployment may share one cluster, but no cross-schema foreign key, query, or transaction crosses the context boundary.

### Public and service interfaces

- The public Gate Authority interface is versioned HTTPS JSON described by OpenAPI 3.1.
- Server-Sent Events provide browser progress and lifecycle updates. Verified Progress and Activity Estimate are separate fields and semantics.
- The Gate Authority-to-Pool Adapter stream uses gRPC and Protobuf with at-least-once delivery, explicit event acknowledgements, and version negotiation.
- Workers use unmodified Stratum V1 for the first Pool Offer. BWG does not add Protected Action concepts to Stratum messages.
- The Authority Descriptor is served from a versioned well-known document and publishes issuer identity, endpoints, JWKS, supported algorithms, transports, capabilities, safety limits, source, policies, privacy terms, and license information.
- Hosted Relying Services authenticate challenge-creation calls with a scoped client identifier and high-entropy rotatable secret. Asymmetric client assertions remain an advanced profile.
- Browser code receives a public challenge descriptor and never receives Relying Service credentials.
- The Web Component is framework-agnostic, implemented with SolidJS, style-isolated, and distributed as hosted and self-hostable assets. The headless interface supports conforming custom clients.

### Action Policy and challenge issuance

- Only an authenticated Relying Service backend may create a Work Challenge.
- Challenge creation selects an audited Action Policy revision and provides an opaque Action Reference plus only allowed bounded overrides.
- The immutable Action Policy revision also pins the Protected Action's execution deadline, maximum attempts, and retryable-error classes.
- An issued challenge immutably binds the Relying Service audience, Protected Action type, Action Reference, Claimant key, Work Requirement, Reward Policy, Pool Offers, expiry, and protocol version.
- Browser hints such as locale or available Worker class are non-authoritative and cannot reduce work, alter rewards, extend expiry, or change action binding.
- The reference account-creation Action Policy uses Standard work: `2^44` expected hashes, represented to users as 44 bits of Equivalent Binary-Zero Work.
- Configurable reference presets are Light `2^42`, Standard `2^44`, and Elevated `2^46`; presets are product defaults rather than protocol constants.
- Equivalent risk receives equivalent normalized work. Worker speed changes estimated duration only.
- Bitcoin network difficulty does not automatically rescale Gate Policy.

### Claimant keys, consent, and privacy

- The browser generates a fresh, non-extractable, pairwise proof-of-possession key for each challenge context and retains it through the bounded public Outcome Lookup window before deleting it.
- Work Consent is user-initiated and records the disclosed Work Requirement, selected Workers, Pool Offer, Reward Policy, Payout Destination, estimates, cancellation behavior, and applicable safety limits.
- Work never starts on page load. Client work ceilings are mandatory.
- Light and Standard local work may be confirmed in the conforming Web Component. Elevated work and materially changed Pool Offer terms require an independently rendered Authority-origin WebAuthn ceremony with user presence, user verification, trusted non-self attestation, and an exact disclosure-bound Authority-signed receipt forwarded to lease start.
- The Relying Service receives only the Action Reference and Gate Pass, not Account Identity, Device Identity, Worker identity, or Payout Destination.
- The Pool Adapter receives only the Work Session mapping and payout data necessary to route work and construct rewards.
- Payout Destinations are per-challenge and ephemeral by default. Local or account persistence is opt-in and outside Core accountless operation.
- Logs, analytics, URLs, QR codes, support artifacts, and public tokens never contain credentials or unrelated identity data.

### Work Sessions and Worker safety

- One Work Challenge may aggregate several concurrent or successive Work Sessions.
- Each Work Session uses unique short-lived Stratum credentials and unique extranonce space mapped one-to-one to the challenge.
- Reference Firmware performs challenge work only under an authenticated Work Lease with a 60-second maximum duration and renewal every 20 seconds while continuity remains healthy.
- Firmware converts accepted lease duration to a monotonic deadline. Reboot, monotonic reset, uncertain time, cancellation, expiry, or lost required continuity ends the lease.
- Before starting, Reference Firmware captures the Mining Baseline. Ending a lease restores ordinary mining state without persisting challenge credentials.
- Gate Pass issuance ends every Work Lease. Continued mining requires a separate future product and separate consent.
- Pause removes active leases and restores Workers while retaining Verified Progress until Work Challenge expiry.
- Explicit Cancel Challenge is terminal and prevents partial progress from later authorizing an action.
- Tab closure and connectivity loss behave as Pause rather than terminal cancellation.

### Work arithmetic and progress

- Credited Work is integer expected hashes calculated from the server-assigned target using `floor(2^256 / (target + 1))`.
- The assigned target effective for the submitted share determines credit. The actual hash's accidental depth does not increase credit.
- Worker-reported hashrate and estimated hashes never count toward completion.
- JSON represents exact work without floating-point loss; binary contracts use a fixed-width unsigned representation. Canonical encoding details and vectors must be settled before stabilizing `BWG/1`.
- An Accepted Work Event includes stable adapter event identity, Work Session identity, assigned target, server receipt time, stable share fingerprint, and network-target outcome.
- The Gate Authority transactionally inserts a new event, rejects duplicate event identities or share fingerprints, computes Credited Work, advances the challenge projection, records adapter acknowledgement state, and durably schedules pass issuance when the threshold is reached.
- Verified Progress is the sum of accepted target-derived work. Activity Estimate is display-only and may reset without affecting authorization.
- The reference variable-difficulty policy aims for an accepted Bitaxe-class share about every two seconds and, when practical, keeps one share below 25 percent of the Work Requirement.

### Persistence and event delivery

- PostgreSQL is the authoritative store for immutable challenge policy, Work Sessions, append-only Accepted Work Events, Credited Work projections, pass metadata, expiry state, downstream issuance intent, and adapter acknowledgement state.
- The Relying Service's separate PostgreSQL schema authoritatively stores Action Reference binding, Trusted Authority Keys, Pass Consumption, Redemption Records, Protected Action Outcomes, action-execution intent and attempts, and proof replay state.
- Runnable services, integration tests, and acceptance tests use PostgreSQL. In-memory adapters are limited to isolated domain-unit tests and cannot provide durability evidence.
- Event delivery is at least once. The Pool Adapter durably records an Accepted Work Event before returning an accepted response to the Worker and resends until acknowledged.
- Exactly-once distributed transactions are not required; idempotent event processing provides the observable guarantee.
- Redis or another cache may accelerate progress fan-out but never becomes the source of truth.
- Gate Pass signing, Protected Action execution, SSE delivery, and other downstream effects use durable outbox-style intent and reclaimable leases so process failure cannot lose a completed transition.

### Lifecycle and expiry

- Work Challenge satisfaction remains a durable accounting fact independent of the associated issuance state.
- Gate Pass issuance states are `pending`, `signing`, `issued`, and terminal `failed`; an expired signing lease is reclaimable, but an unsigned intent fails permanently at Work Challenge expiry.
- Work Session states are ready, leased, stopping, restored, and failed.
- A Work Challenge expires 15 minutes after issuance by default.
- A Gate Pass's `iat` and two-minute expiry begin when the first exact compact JWS is durably stored and retrievable; it cannot be refreshed, extended, banked, exchanged, or reused.
- A DPoP Redemption proof is single-use and accepted only within a 60-second clock window.
- Accepted Work Events received after challenge expiry do not count toward authorization.
- Pool handling of a possible network-valid block remains independent of challenge expiry and gate accounting.

### Gate Pass and Redemption

- Gate Passes use a tightly constrained compact JWS profile with an explicit BWG type, fully specified Ed25519 issuer signatures, and mandatory issuer, audience, issue/expiry time, unique pass identity, challenge identity, Protected Action Type, Action Reference, immutable Action Policy revision, and Claimant-key confirmation claims.
- The issuance intent pins the pass identity, claims, algorithm, and challenge-expiry signing deadline. The first successful signer selects an eligible active key and atomically stores its `kid` with the one exact compact JWS.
- Claimant Issuance Proof authenticates bounded read-only lookup by Work Challenge ID, returning `pending`, the exact stored pass, or terminal `failed` without causing signing or extending expiry.
- Authority keys come from the Relying Service's durable explicitly trusted local key set. An unfamiliar `kid` may cause one bounded refresh before Redemption begins, but a token-supplied arbitrary key URL is not trusted and no live Authority call occurs inside Redemption.
- Redemption uses DPoP to bind the Claimant key to the HTTP method, target URI, and Gate Pass hash.
- The Relying Service validates the unexpired pass and fresh DPoP proof, then atomically consumes `(issuer, pass_id)` while enforcing one Redemption Record for `(audience, Action Reference)`.
- The first valid Redemption atomically creates that Redemption Record, one pending Protected Action Outcome, and one Action Execution Intent. Later valid same-Claimant passes are consumed and linked to the existing record without restarting execution; conflicting Claimant keys fail without consumption or disclosure.
- Protected Action execution uses the Action Reference as a downstream idempotency key and advances the outcome from `pending` to immutable terminal `succeeded` or `failed`. Failure never reverses Redemption or Pass Consumption.
- Claimant Outcome Proof authenticates read-only lookup by Action Reference for a configurable window defaulting to 24 hours. Lookup returns only safe `pending`, `succeeded`, or `failed` representations and cannot authorize, execute, retry, or restart the action.
- Unknown Action References, wrong Claimant keys, and expired public lookup windows are externally indistinguishable.

### Pool Offer, rewards, and mainnet

- A Work Challenge carries one or more Gate-Authority-approved Pool Offers. The first reference deployment publishes one default offer.
- Each Pool Offer discloses Mining Pool and Pool Adapter identity, Mining Transport, endpoint, Reward Policy, fees, payout requirements, source, license, and operator terms.
- Automatic failover is allowed only among pre-consented offers with materially equivalent reward, fee, payout, and privacy terms.
- V1 uses solo-style direct coinbase payouts. Lower-difficulty accepted work advances gate progress but creates no claim on future pool revenue.
- A network-valid result pays the disclosed Payout Destinations directly through the coinbase. No custodial balance, payout threshold, or PPLNS ledger is introduced.
- The Pool Adapter proxy is MIT-licensed and co-located in front of a pinned Hydra release. Hydra and P2Pool remain separately licensed and replaceable.
- The proxy forwards Stratum jobs and submissions without changing them, observes targets and accepted responses, and delivers BWG events without adding Protected Action concepts to Hydra.
- Before any exact mainnet job reaches a Worker, the pool path independently verifies Reward Policy outputs and obtains BIP 23 proposal acceptance for the exact constructed candidate block.
- Missing full-template data, unavailable proposal validation, inconclusive response, payout mismatch, or validation failure prevents mainnet job release.
- The preferred Hydra/P2Pool change is a generic upstreamable pre-`mining.notify` job-admission hook rather than BWG-specific pool logic.
- A network-valid block candidate is submitted immediately through the Mining Pool's Bitcoin-node path without waiting for BWG accounting, storage, or application services.
- A stale block or later chain reorganization does not revoke a Gate Pass because the underlying work was performed.
- Real integration may use mainnet from the outset. Deterministic equivalents remain continuous CI evidence rather than an environment stage gate.

### Onboarding and Reference Client

- The first screen asks about a compatible Bitcoin miner rather than requiring a Bitaxe.
- Previously managed remote Workers are outside Core MVP operation, although the public interfaces must not prevent the later Worker Authorization extension.
- The local Bitaxe path uses a direct user gesture to connect over USB and reads only non-secret capability and version information before consent.
- Compatible Reference Firmware proceeds directly. Other firmware may be replaced through a signed, board-compatible, settings-preserving flow.
- Firmware manifests bind image digest, board compatibility, version, partition requirements, and supported settings-schema range.
- NVS settings are preserved by default. Optional credential-bearing Migration Backups remain local, encrypted with user-provided material, and absent from service logs and storage.
- Post-reboot verification reports redacted categories and hashes rather than raw credentials.
- Onboarding stops when compatible preservation, rollback, or safe recovery cannot be established.
- Other compliant Workers receive an advanced flow for short-lived Stratum configuration.
- When no Worker is available, the client explains the requirement and shows Relying-Service-configured alternatives without claiming that mining proves humanity.

### Technology and versioning

- The Gate Authority uses a Rust Cargo workspace, Tokio, Axum, SQLx with PostgreSQL, tonic with Protobuf, and rustls.
- Frontend packages use Bun, TypeScript, SolidJS, and a framework-agnostic custom element.
- Business logic is implemented as data-in, data-out functions with parsed domain types and explicit effects.
- Project-defined class inheritance is not used; composition and explicit adapters are preferred.
- Development uses `BWG/0.x` until complete Conformance Profiles pass. Stable public HTTP paths use `/v1` when `BWG/1` is declared.
- Unknown non-critical JSON fields may be ignored. Unknown critical fields fail closed. Removed Protobuf field numbers remain reserved.
- Changed work accounting, trust, signature, or lifecycle semantics require a new major protocol version.
- An issued challenge or pass is always interpreted under the version it names.
- Public applications expose source, version, short commit, and build provenance through normal product chrome.

## Testing Decisions

### Testing philosophy

- Tests verify observable behavior through module interfaces and public protocol seams rather than private methods, internal database queries, implementation-specific call counts, or hidden collaborators.
- Every persistence, restart, concurrency, response-loss, or recovery claim is tested against PostgreSQL rather than an in-memory repository.
- Each unit test covers one concern and follows Arrange, Act, Assert structure. Explicit section comments are used unless the structure is unmistakable without them.
- Expected values come from independent worked vectors, Bitcoin specifications, external protocol fixtures, or accepted scenario outcomes rather than recomputing results through the same implementation logic.
- One vertical red-green slice is implemented at a time. Bulk horizontal test suites are not written ahead of the behavior they exercise.
- Refactoring occurs after green behavior, during review, without weakening the established interface tests.

### Public seam 1: reference account-creation journey

- The primary acceptance harness drives the Reference Relying Service, Web Component or headless client, public Gate Authority HTTP/SSE interface, simulated Pool Adapter and Worker, JWS Gate Pass, DPoP Redemption, and idempotent account-creation outcome.
- The harness uses public role interfaces only and does not inspect PostgreSQL or private application state to prove behavior.
- Positive scenarios cover challenge issuance, Work Consent, multiple Accepted Work Events, Verified Progress, threshold completion, Work Lease termination, crash-recoverable Gate Pass issuance, DPoP Redemption, Action Execution, and durable Outcome Lookup.
- Negative scenarios cover invalid Action Policy, browser policy tampering, insufficient work, duplicate event identity, duplicate share fingerprint, event replay, expired challenge, issuance deadline failure, expired pass, replayed proofs, wrong audience, wrong Action Reference, wrong Claimant key, concurrent Redemption, backend response loss, and worker lease expiry.
- Lifecycle scenarios cover Pause, resume, explicit Cancel, tab loss, Worker replacement, equivalent pool failover, changed terms requiring consent, and Authority or pool outage with explicit fallback labeling.
- Privacy scenarios assert that prohibited identity, payout, credential, network, and action-payload data never appears in public challenge, Gate Pass, SSE, log, or Relying Service surfaces.
- Browser scenarios cover keyboard operation, screen-reader semantics, contrast, reduced motion, closed progress semantics, trusted-origin confirmation, and framework-independent custom-element use.

### Public seam 2: real mining path

- A black-box mining harness drives a standard Stratum V1 Worker through the Pool Adapter proxy and pinned Hydra to Bitcoin Core.
- Deterministic test environments validate subscribe, authorize, target assignment, notify, submit, accepted and rejected responses, stale jobs, duplicate submissions, reconnect, and vardiff transitions.
- Pool Adapter tests prove that the target effective at submission becomes the event target, accepted acknowledgement follows durable event recording, and event replay does not duplicate Credited Work.
- Job-admission tests assemble the exact candidate block, independently verify Reward Policy outputs, call Bitcoin Core BIP 23 proposal mode, and withhold `mining.notify` on every missing, invalid, inconclusive, or mismatched result.
- Block-candidate tests prove immediate submission remains available when Gate Authority event delivery, PostgreSQL, or application services are unavailable.
- Mainnet evidence is bounded, redacted, and tied to the exact source, engine pin, Reward Policy, Bitcoin Core result, and cleanup outcome. Mainnet use does not replace deterministic regression coverage.

### Public seam 3: Reference Firmware contract

- A simulated-device harness exercises the public Worker Controller/USB contract for capability discovery, firmware admission, Work Lease start, renewal, Pause, Cancel, expiry, reboot, lost continuity, and Mining Baseline restoration.
- Settings tests verify supported schema migration, default preservation, local-only encrypted backup, rollback markers, redacted post-reboot confirmation, and failure before unsafe flash.
- Secret-handling tests prove credentials never appear in public protocol fields, URLs, QR codes, logs, analytics, support artifacts, or remote storage.
- Real Bitaxe verification is performed in the firmware repository through its repo-native hardware safety and evidence workflow. The shared contract fixtures remain the cross-repository acceptance source.

### Pure module contracts

- Exact work arithmetic uses canonical fixed vectors for targets at boundaries, difficulty-1 equivalence, fractional human display, zero and invalid targets, overflow, serialization, and cumulative addition.
- Lifecycle tests cover every allowed and forbidden Work Challenge and Work Session transition, including expiry and monotonic lease rules.
- Gate Pass tests use canonical JWS, JWKS rotation, DPoP, audience, action, key-confirmation, time-window, and replay vectors.
- Action Policy tests prove immutable revision binding, bounded overrides, equivalent-risk pricing, and rejection of browser-authored authority.
- Reward Policy and Pool Offer tests prove immutable disclosed terms, payout commitment, equivalent failover classification, and changed-term consent.
- Projection tests prove at-least-once event delivery, durable acknowledgement, deduplication, threshold crossing, outbox intent, and deterministic reconstruction from the append-only ledger.

### Conformance and continuous verification

- Versioned Conformance Profiles exist independently for Client, Gate Authority, Pool Adapter, and Relying Service roles.
- Every profile publishes executable positive and negative fixtures plus a reproducible command suitable for CI.
- Self-certification is acceptable initially, but a compatibility claim names the exact profile version and publishes reproducible results.
- Bright Builds checks, Rust formatting, Clippy with warnings denied, all-target/all-feature builds, and all-feature tests run before commits once the respective project manifests exist.
- TypeScript formatting, linting, typechecking, production build, and tests run through Bun-owned repository scripts once the frontend workspace exists.
- The reference integration includes end-to-end evidence for every Core MVP success criterion and records residual risks rather than inferring completion from passing unit tests alone.

### Prior art

- This repository currently contains no implementation tests. The accepted domain glossaries, lifecycle tables, threat model, success criteria, and ADRs are the behavioral source for initial fixtures.
- Bitcoin Core BIP 23 behavior, JOSE/DPoP standards, Stratum V1 behavior, and exact Bitcoin target arithmetic provide independent protocol vectors.
- Reference Firmware hardware tests follow the firmware repository's established safety, privacy, restoration, and exact-boundary evidence contracts rather than inventing a parallel hardware process here.

## Out of Scope

- Proof of humanity, uniqueness, personal identity, physical Bitaxe ownership, hardware attestation, actual joules consumed, clean-energy provenance, or freedom from automation.
- Persistent Account Identity, passkeys, email-code login, NIP-46/NIP-98 login, Recovery Codes, or account recovery.
- Persistent Device Identity, Pairing Ceremony, Owner Grants, Device Reclamation, Device Relay, Relay Sessions, or remote Worker Authorization.
- iOS or Android management applications, Capacitor shell, remote fleet management, or full-parity Worker dashboards.
- Remote voltage, frequency, fan, thermal, Wi-Fi, pool-credential, factory-reset, or irreversible eFuse control.
- Hosted Telemetry History, extended retention tiers, telemetry billing, or sensitive raw-log collection.
- General-purpose Digital Energy Credits, account-bound balances, transferable credits, or banked gate work.
- Recurring donated-work billing, subscriptions, Lightning payment implementation, or other service-payment systems.
- Automatic continued mining after Gate Pass issuance or any continuous-mining product.
- PPLNS, PPS, FPPS, custodial balances, deferred pool payouts, payout thresholds, or a secondary reward market.
- A new mining protocol, custom Stratum extension, challenge data embedded in coinbases or headers, or independent cryptographic work receipts.
- A Rust rewrite of Hydra or another Mining Pool engine.
- Stratum V2 in the first reference Pool Offer; it remains a future adapter using the same BWG interfaces.
- Multi-user Operator or Viewer Control Grants.
- Automatic irreversible secure-boot or flash-encryption eFuse enablement during ordinary onboarding.
- Staff override for account or device recovery.
- Global trustlessness between Relying Services, Gate Authorities, Pool Adapters, Mining Pools, relays, firmware, and clients.
- Guarantee that BWG alone stops abuse; Relying Services retain responsibility for their broader Abuse Policy.
- Equal wall-clock wait across Worker speeds; equivalent work, not equivalent time, is the pricing invariant.

## Further Notes

- The specification is derived from the established multi-context domain model and accepted system-wide ADRs. A ticket or implementation that conflicts with those decisions must name and deliberately reopen the relevant ADR before proceeding.
- Project-authored protocols, services, SDKs, adapters, clients, and firmware additions remain MIT-licensed. Hydra and P2Pool retain their separately disclosed licenses and stay out of process.
- The mainnet job-admission hook is a concrete pre-release blocker. The current pinned Hydra/P2Pool path must not be assumed to provide suitable pre-work BIP 23 acceptance until the exact hook and success semantics are implemented and verified.
- Canonical 256-bit work encoding, browser DPoP algorithm support, JOSE key operations, USB provisioning, and concrete data-retention operations remain bounded implementation-research tasks. They should become blocker-aware tracer-bullet tickets rather than reopening BWG Core's product scope.
- The next workflow step is `to-tickets`, which should split this specification into demoable vertical slices sized for one fresh implementation context and declare every genuine blocking edge.
