INSERT INTO relying_service.pass_consumptions (
    issuer,
    pass_id,
    redemption_id,
    consumed_at_unix_seconds,
    gate_pass_expires_at_unix_seconds
)
VALUES ($1, $2, $3, $4, $5)
