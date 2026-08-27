INSERT INTO gate_authority.work_sessions (
    session_id, challenge_id, pool_offer_id, payout_commitment,
    replaces_session_id, replacement_generation, replacement_reason
)
VALUES ($1, $2, $3, $4, $5, $6, $7)
