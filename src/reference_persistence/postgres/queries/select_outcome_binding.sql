SELECT redemption_id, claimant_jkt, public_lookup_expires_at_unix_seconds
FROM relying_service.redemption_records
WHERE audience = $1 AND action_reference = $2
