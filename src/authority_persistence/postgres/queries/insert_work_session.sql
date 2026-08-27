INSERT INTO gate_authority.work_sessions (
    session_id,
    challenge_id,
    pool_offer_id,
    payout_commitment
)
SELECT $1, $2, $3, $4
WHERE NOT EXISTS (
    SELECT 1
    FROM gate_authority.pool_offer_replacements
    WHERE candidate_session_id = $1
      AND status = 'pending_reconfirmation'
)
