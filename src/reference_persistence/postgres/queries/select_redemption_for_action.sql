SELECT redemption_id
FROM relying_service.redemption_records
WHERE audience = $1 AND action_reference = $2
