SELECT session.challenge_id, session.lifecycle_state, session.stop_reason,
       session.pool_offer_id, session.payout_commitment,
       challenge.lifecycle_state AS challenge_state,
       challenge.expires_at_unix_seconds
FROM gate_authority.work_sessions AS session
JOIN gate_authority.work_challenges AS challenge
  ON challenge.challenge_id = session.challenge_id
WHERE session.session_id = $1
FOR UPDATE OF session, challenge
