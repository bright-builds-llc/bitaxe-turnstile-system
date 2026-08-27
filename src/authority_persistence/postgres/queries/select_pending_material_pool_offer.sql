SELECT challenge_id, replaced_session_id, candidate_session_id,
       prior_offer, candidate_offer, change
FROM gate_authority.pool_offer_replacements
WHERE replaced_session_id = $1 AND status = 'pending_reconfirmation'
