SELECT redemption_id
FROM relying_service.pass_consumptions
WHERE issuer = $1 AND pass_id = $2
