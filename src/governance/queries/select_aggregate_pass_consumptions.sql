SELECT issuer,
       pass_id,
       consumed_at_unix_seconds,
       gate_pass_expires_at_unix_seconds
FROM pass_consumptions
WHERE redemption_id = $1
ORDER BY issuer, pass_id
FOR UPDATE
