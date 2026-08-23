UPDATE relying_service.pass_consumptions
SET consumed_at_unix_seconds = $2,
    gate_pass_expires_at_unix_seconds = $3
WHERE redemption_id = $1
