SELECT intent.challenge_id, intent.algorithm, intent.claims_template
FROM gate_authority.gate_pass_issuance_intents AS intent
JOIN gate_authority.work_challenges AS challenge
    ON challenge.challenge_id = intent.challenge_id
WHERE
    intent.signing_deadline_unix_seconds > $1
    AND (
        intent.status = 'pending'
        OR (
            intent.status = 'signing'
            AND intent.signing_lease_expires_at_unix_seconds <= $1
        )
    )
ORDER BY intent.signing_deadline_unix_seconds, intent.challenge_id
FOR UPDATE OF intent SKIP LOCKED
LIMIT 1
