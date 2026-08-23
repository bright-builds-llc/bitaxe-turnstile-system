# Profile Gate Passes with JWS and DPoP

Gate Passes will use a tightly constrained compact JWS profile with an explicit type, fully specified Ed25519 issuer signatures, and mandatory issuer, audience, time, unique-pass, challenge, protected-action-type, action-reference, action-policy, and Claimant-key confirmation claims. Redemption will use RFC 9449 DPoP to bind the Claimant key to the request and pass hash, while the Relying Service validates against its durable local Trusted Authority Key Set and atomically consumes the unique pass identifier.
