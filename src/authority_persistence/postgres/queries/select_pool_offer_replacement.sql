SELECT replaced_session_id, candidate_session_id, status,
       prior_offer, candidate_offer, candidate_signature, candidate_set_digest, change
FROM gate_authority.pool_offer_replacements
WHERE replaced_session_id = $1
