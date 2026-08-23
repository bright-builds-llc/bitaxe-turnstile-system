# Discover Gate Authorities with well-known metadata

Gate Authorities will publish a versioned `/.well-known/pow-gate-configuration` Authority Descriptor covering issuer identity, endpoints, JWKS, supported algorithms and transports, capabilities, safety limits, source, operator policy, privacy, terms, and licenses. Discovery simplifies SDK and self-host configuration but grants no trust: each Relying Service explicitly configures the issuers and keys it accepts.
