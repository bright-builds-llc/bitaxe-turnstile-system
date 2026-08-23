UPDATE relying_service.pass_consumptions
SET gate_pass_expires_at_unix_seconds = consumed_at_unix_seconds
WHERE issuer = 'https://authority.example'
  AND pass_id = 'pass_retention'
