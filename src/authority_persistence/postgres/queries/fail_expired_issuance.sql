WITH expired AS (
    UPDATE gate_authority.gate_pass_issuance_intents
    SET
        status = 'failed',
        signing_lease_owner = NULL,
        signing_lease_expires_at_unix_seconds = NULL
    WHERE
        status IN ('pending', 'signing')
        AND signing_deadline_unix_seconds <= $1
    RETURNING challenge_id
)
UPDATE gate_authority.authority_outbox AS outbox
SET status = 'failed'
FROM expired
WHERE
    outbox.aggregate_id = expired.challenge_id
    AND outbox.kind = 'gate_pass_signing'
