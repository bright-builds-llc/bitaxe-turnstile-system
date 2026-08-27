SELECT replaced_session_id
FROM gate_authority.pool_offer_replacements
WHERE candidate_session_id = $1
  AND status = 'pending_reconfirmation'
