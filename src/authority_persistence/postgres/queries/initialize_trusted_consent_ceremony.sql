UPDATE gate_authority.trusted_consent_ceremonies AS ceremony
SET status = 'pending',
    creation_options = $3,
    registration_state = $4,
    operation_owner = NULL,
    operation_lease_expires_at_unix_seconds = NULL
FROM gate_authority.work_challenges AS challenge
WHERE ceremony.ceremony_id = $1
  AND ceremony.status = 'starting'
  AND ceremony.operation_owner = $2
  AND ceremony.operation_lease_expires_at_unix_seconds > $5
  AND ceremony.expires_at_unix_seconds > $5
  AND challenge.challenge_id = ceremony.challenge_id
  AND (
      challenge.lifecycle_state = 'issued'
      OR (ceremony.reason = 'material_pool_terms' AND challenge.lifecycle_state = 'active')
  )
  AND challenge.expires_at_unix_seconds > $5
RETURNING ceremony.*
