UPDATE gate_authority.trusted_consent_ceremonies AS ceremony
SET status = 'verified',
    verified_at_unix_seconds = $3,
    operation_lease_expires_at_unix_seconds = NULL,
    operation_owner = NULL,
    creation_options = NULL,
    registration_state = NULL
FROM gate_authority.work_challenges AS challenge
WHERE ceremony.ceremony_id = $1
  AND ceremony.status = 'verifying'
  AND ceremony.operation_owner = $2
  AND ceremony.operation_lease_expires_at_unix_seconds > $3
  AND challenge.challenge_id = ceremony.challenge_id
  AND (
      challenge.lifecycle_state = 'issued'
      OR (ceremony.reason = 'material_pool_terms' AND challenge.lifecycle_state = 'active')
  )
  AND challenge.expires_at_unix_seconds > $3
RETURNING ceremony.*
