INSERT INTO gate_authority.pool_offer_replacements (
    replaced_session_id, candidate_session_id, challenge_id, status,
    prior_offer, candidate_offer, candidate_signature, candidate_set_digest,
    change, decided_at_unix_seconds
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
ON CONFLICT (replaced_session_id) DO NOTHING
RETURNING replaced_session_id, candidate_session_id, status,
          prior_offer, candidate_offer, candidate_signature, candidate_set_digest, change
