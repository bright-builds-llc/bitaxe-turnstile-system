SELECT jwk
FROM relying_service.trusted_authority_keys
WHERE issuer = $1
ORDER BY kid
