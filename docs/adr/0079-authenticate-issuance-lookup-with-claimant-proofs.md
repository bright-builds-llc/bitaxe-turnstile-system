# Authenticate Issuance Lookup with dedicated Claimant proofs

Issuance Lookup requires a short-lived Claimant Issuance Proof with an explicit proof type, public JWK, unique identifier, issued-at time, request method and URI binding, and the exact Work Challenge ID. The Gate Authority matches the proof key's thumbprint to the challenge and rejects stale or replayed proofs; this dedicated proof cannot issue or redeem a Gate Pass.
