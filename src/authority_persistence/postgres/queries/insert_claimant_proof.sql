INSERT INTO gate_authority.claimant_issuance_proofs (
    proof_id,
    challenge_id,
    expires_at_unix_seconds
)
VALUES ($1, $2, $3)
