INSERT INTO gate_authority.gate_pass_issuance_intents (
    challenge_id,
    pass_id,
    algorithm,
    claims_template,
    signing_deadline_unix_seconds,
    status
)
VALUES ($1, $2, $3, $4, $5, 'pending')
