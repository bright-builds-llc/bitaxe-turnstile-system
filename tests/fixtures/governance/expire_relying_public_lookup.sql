UPDATE relying_service.redemption_records
SET public_lookup_expires_at_unix_seconds = $2
WHERE redemption_id = $1
