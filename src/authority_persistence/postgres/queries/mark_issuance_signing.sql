UPDATE gate_authority.gate_pass_issuance_intents
SET
    status = 'signing',
    signing_lease_owner = $2,
    signing_lease_expires_at_unix_seconds = $3
WHERE challenge_id = $1
