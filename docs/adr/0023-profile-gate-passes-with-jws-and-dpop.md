# Profile Gate Passes with JWS and DPoP

Gate Passes will use a tightly constrained compact JWS profile with an explicit type, fully specified Ed25519 issuer signatures, trusted configured or issuer-discovered keys, and mandatory issuer, audience, time, unique-pass, challenge, action-reference, and Claimant-key confirmation claims. Redemption will use RFC 9449 DPoP to bind the Claimant key to the request and pass hash, while the Relying Service still atomically consumes the unique pass identifier.
