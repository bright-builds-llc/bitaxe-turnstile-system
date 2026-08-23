UPDATE relying_service.pass_consumptions
SET gate_pass_expires_at_unix_seconds = 200
WHERE issuer = 'https://authority.example'
  AND pass_id = 'pass_legacy_retention'
