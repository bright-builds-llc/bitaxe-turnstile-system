INSERT INTO gate_authority.work_sessions (
    session_id,
    challenge_id,
    pool_offer_id,
    payout_commitment
)
VALUES ($1, $2, $3, $4)
