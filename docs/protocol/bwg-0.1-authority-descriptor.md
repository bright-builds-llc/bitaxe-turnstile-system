# BWG/0.1 Authority Descriptor

Gate Authorities publish `GET /.well-known/pow-gate-configuration` as a public HTTPS JSON discovery document and `GET /.well-known/jwks.json` as its public verification-key set. Discovery communicates configuration; it does not grant trust.

## Published contract

The descriptor includes:

- issuer identity and `BWG/0.1` protocol version;
- versioned challenge, progress, descriptor, and JWKS endpoints;
- the current and overlap-rotation Authority verification keys;
- mandatory Gate Pass, browser DPoP, JWK-thumbprint, and access-token-hash algorithms;
- public API, progress, Pool Adapter, and Worker transports;
- supported capabilities and their criticality;
- Action Reference, Claimant key, challenge, Gate Pass, and DPoP limits;
- immutable Action Policy revision defaults and permitted exact-work override bounds;
- source repository, package version, commit, and build provenance;
- operator policy, privacy, terms, and MIT license metadata.

Unknown ordinary JSON members are non-critical hints and may be ignored. A name listed in `critical_capabilities` must be understood by the consumer. Likewise, each policy's `critical_fields` list identifies policy members that must be understood. An unknown listed name fails closed.

## Trust configuration

A Relying Service separately configures the exact issuer and Authority verification keys it trusts. Fetching a descriptor, following its JWKS URL, or finding a matching `kid` never adds an issuer or key to that trust set. Rotation is accepted only when the incoming key is already present in operator-approved trust configuration; retired keys are removed deliberately after the overlap window.

## Hosted backend credentials

Challenge creation also requires a backend-only client identifier and high-entropy secret. The Authority stores only a verifier, binds each credential to one deployment environment, Relying Service audience, allowed browser origins, permitted operation, and Action Policy revisions, and supports brief old/new-secret overlap. Neither credential value is included in a Work Challenge, descriptor, JWKS response, or browser request.
