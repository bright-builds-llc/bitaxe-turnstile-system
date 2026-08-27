SELECT replacement.challenge_id,
       replacement.replaced_session_id,
       replacement.candidate_session_id,
       replacement.status,
       replacement.prior_offer,
       replacement.candidate_offer,
       predecessor.lifecycle_state AS predecessor_state,
       predecessor.stop_reason AS predecessor_stop_reason,
       candidate.lifecycle_state AS candidate_state,
       candidate.stop_reason AS candidate_stop_reason
FROM gate_authority.pool_offer_replacements AS replacement
JOIN gate_authority.work_sessions AS predecessor
  ON predecessor.session_id = replacement.replaced_session_id
LEFT JOIN gate_authority.work_sessions AS candidate
  ON candidate.session_id = replacement.candidate_session_id
WHERE replacement.replaced_session_id = $1
