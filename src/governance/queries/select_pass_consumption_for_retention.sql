SELECT redemption_id,
       consumed_at_unix_seconds,
       gate_pass_expires_at_unix_seconds
FROM pass_consumptions
WHERE issuer = $1 AND pass_id = $2
FOR UPDATE
