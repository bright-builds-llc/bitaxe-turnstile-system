# Proof-of-Work Gating

This context describes resource-backed authorization for protected actions. It deliberately does not model proof of humanity, identity, or device ownership.

## Language

**Proof-of-Work Gate**:
A control that requires fresh, quantifiable computational work before authorizing a protected action.
_Avoid_: CAPTCHA, turnstile, human-verification check

**Claimant**:
The party seeking authorization for a protected action and controlling the key bound to its work challenge; a Claimant may be anonymous and need not have an account or mobile app.
_Avoid_: Human, user account, worker

**Protected Action**:
An action whose authorization is conditioned on satisfying a proof-of-work gate, such as creating an account.
_Avoid_: Request, API call

**Action Reference**:
An opaque Relying Service identifier that binds a Work Challenge and Gate Pass to a Protected Action without revealing the action payload or personal data.
_Avoid_: Email address, account identifier, serialized request

**Work Challenge**:
A bounded demand for fresh computational work associated with a protected action and Claimant, which may aggregate contributions from multiple Workers.
_Avoid_: CAPTCHA challenge, mining task

**Work Requirement**:
The normalized quantity of computational work that must be credited to complete a work challenge.
_Avoid_: Required share count, network difficulty

**Work Consent**:
The Claimant's informed, user-initiated approval of a disclosed Work Requirement, participating Workers, estimated cost, and Reward Policy within client-controlled limits.
_Avoid_: Page load, blanket site permission, hidden mining

**Gate Policy**:
The Relying Service's bounded rules for deriving a Work Requirement from the Protected Action and abuse risk, independent of the Claimant's Worker speed.
_Avoid_: Estimated duration, pool variable difficulty, self-reported hashrate

**Action Policy**:
An audited, versioned Gate Policy configuration for one Protected Action type, pinned immutably into every challenge it issues.
_Avoid_: Arbitrary browser parameters, mutable active policy, Action Reference

**Abuse Policy**:
The Relying Service's broader authorization rules, which may combine a Gate Pass with identity, reputation, quotas, velocity limits, or review.
_Avoid_: Proof-of-Work Gate, proof of humanity, guaranteed bot prevention

**Reward Policy**:
The immutable, pre-work declaration of how any mining proceeds attributable to a Work Challenge are allocated among the Claimant, pool, and service parties.
_Avoid_: Hidden donation, Work Requirement, guaranteed payout

**Payout Destination**:
A per-challenge Bitcoin address designated to receive a direct share of any block reward, whether for the Claimant or an explicitly selected beneficiary; persistence is opt-in.
_Avoid_: Custodial balance, promised reward, service credit

**Work Proof**:
Evidence that the computational work demanded by a work challenge has been completed.
_Avoid_: Proof of humanity, proof of identity

**Credited Work**:
Integer expected hashes derived from the server-assigned targets of accepted results, independent of how a Worker's results are divided into shares.
_Avoid_: Share count, hashes reported by a worker

**Equivalent Binary-Zero Work**:
A human-readable, potentially fractional base-2 logarithm of exact expected hashes, describing the difficulty of a hypothetical single-hash leading-zero puzzle with equivalent work.
_Avoid_: Credited Work, literal share requirement, actual hash zero count

**Verified Progress**:
Cumulative Credited Work established by Accepted Work Events for a Work Challenge.
_Avoid_: Hashrate estimate, animation, Worker-reported hashes

**Activity Estimate**:
A non-authoritative indication that work is ongoing, derived from recent share cadence or local telemetry and kept distinct from Verified Progress.
_Avoid_: Credited Work, completion evidence

**Gate Pass**:
A short-lived, single-use authorization bound to both the protected action associated with a completed work challenge and the Claimant's proof-of-possession key.
_Avoid_: Credit, balance, reusable token

**Redemption**:
The one-time exercise of a Gate Pass by its Claimant to authorize the associated protected action.
_Avoid_: Login, payment, token validation

**Redemption Record**:
The durable server-side outcome created when an unexpired Gate Pass is atomically consumed; it supports idempotency but grants no continuing authority.
_Avoid_: Reusable Gate Pass, refresh token, service credit

**Gate Authority**:
The party responsible for work-challenge policy, completion, and issuance of gate passes on behalf of a relying service.
_Avoid_: Mining pool, worker

**Authority Descriptor**:
A versioned public discovery document describing a Gate Authority's endpoints, keys, capabilities, limits, policies, and source without making it trusted.
_Avoid_: Trust grant, Gate Pass, private configuration

**Conformance Profile**:
A versioned executable contract for one protocol role, whose reproducible test results support a compatibility claim.
_Avoid_: Marketing badge, implementation language, blanket certification

**Relying Service**:
A website or service that protects an action and trusts one or more Gate Authorities to issue valid gate passes for it.
_Avoid_: Gate Authority, mining pool, verifier

**Bitcoin-Productive Work**:
Computational work performed over a valid Bitcoin block candidate, so a result meeting network difficulty can contribute to Bitcoin consensus even when the gate requires only lower-difficulty evidence.
_Avoid_: Synthetic hashing, arbitrary hash puzzle

**Mining Pool**:
The party that coordinates Bitcoin-productive work and handles share acceptance, candidate blocks, and mining rewards independently of gate policy.
_Avoid_: Gate Authority, relying website

**Pool Offer**:
A Gate-Authority-approved choice of Mining Pool, Pool Adapter, Mining Transport, Reward Policy, payout requirements, and disclosed operator terms available for a Work Challenge.
_Avoid_: Arbitrary pool endpoint, Work Requirement, hidden routing

**Pool Adapter**:
The transport-neutral boundary that associates a Worker's pool session with a Work Challenge and reports normalized accepted work to the Gate Authority.
_Avoid_: Custom Stratum fork, gate policy engine

**Accepted Work Event**:
An idempotently identifiable Pool Adapter report that an accepted, target-qualified result contributed Credited Work to a Work Session.
_Avoid_: Share counter, exactly-once message, Worker hashrate report

**Mining Transport**:
The protocol used between a Worker and Mining Pool, initially standard Stratum V1 and independent of the proof-of-work gating protocol.
_Avoid_: Gate protocol, custom challenge protocol

**Work Session**:
A challenge-scoped association through which one Worker contributes credited work; a Work Challenge may aggregate multiple concurrent or successive Work Sessions.
_Avoid_: Device pairing, user session, account

**Worker**:
A hardware or software agent that performs the computational work needed to satisfy a work challenge; it is not restricted to a particular manufacturer or device class.
_Avoid_: Bitaxe, approved miner, human

**Reference Client**:
An officially supported implementation of the open proof-of-work gating protocol, initially centered on Bitaxe hardware.
_Avoid_: Required miner, protocol-mandated device

**Reference Firmware**:
Officially supported Bitaxe firmware that enables the automated Reference Client experience while preserving existing device settings; it is not required for protocol compliance.
_Avoid_: Mandatory protocol firmware, factory reset
