# Authenticate Outcome Lookup with dedicated Claimant proofs

Outcome Lookup requires a short-lived ES256 Claimant Outcome Proof with an explicit proof type, public JWK, unique identifier, issued-at time, request method and URI binding, and the exact Action Reference. The Relying Service matches the proof key's thumbprint to the Redemption Record and rejects stale or replayed proofs; this dedicated proof cannot authorize Redemption, consume a Gate Pass, or cause action execution.
