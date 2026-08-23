UPDATE gate_authority.gate_pass_issuance_intents
SET
    status = 'issued',
    signing_lease_owner = NULL,
    signing_lease_expires_at_unix_seconds = NULL,
    authority_kid = $3,
    gate_pass = $4,
    issued_at_unix_seconds = $5,
    expires_at_unix_seconds = $6
WHERE
    challenge_id = $1
    AND status = 'signing'
    AND signing_lease_owner = $2
    AND signing_lease_expires_at_unix_seconds > EXTRACT(EPOCH FROM clock_timestamp())::bigint
    AND signing_deadline_unix_seconds > EXTRACT(EPOCH FROM clock_timestamp())::bigint
