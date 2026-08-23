INSERT INTO relying_service.redemption_records (
    redemption_id,
    audience,
    action_reference,
    claimant_jkt,
    protected_action_type,
    action_policy,
    accepted_at_unix_seconds,
    execution_deadline_unix_seconds,
    maximum_attempts,
    public_lookup_expires_at_unix_seconds
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
