DELETE FROM pass_consumptions
WHERE issuer = $1
  AND pass_id = $2
  AND consumed_at_unix_seconds = $3
  AND gate_pass_expires_at_unix_seconds = $4
