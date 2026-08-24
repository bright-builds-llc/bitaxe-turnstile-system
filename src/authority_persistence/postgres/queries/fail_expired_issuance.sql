WITH expired AS (
    UPDATE gate_authority.gate_pass_issuance_intents
    SET
        status = 'failed',
        signing_lease_owner = NULL,
        signing_lease_expires_at_unix_seconds = NULL
    WHERE
        status IN ('pending', 'signing')
        AND signing_deadline_unix_seconds <= $1
    RETURNING challenge_id, signing_deadline_unix_seconds
), terminalized AS (
    UPDATE gate_authority.work_challenges AS challenge
    SET terminal_at_unix_seconds = expired.signing_deadline_unix_seconds,
        lifecycle_state = 'expired',
        lifecycle_changed_at_unix_seconds = expired.signing_deadline_unix_seconds
    FROM expired
    WHERE challenge.challenge_id = expired.challenge_id
    RETURNING challenge.challenge_id
)
UPDATE gate_authority.authority_outbox AS outbox
SET status = 'failed'
FROM terminalized
WHERE
    outbox.aggregate_id = terminalized.challenge_id
    AND outbox.kind = 'gate_pass_signing'
