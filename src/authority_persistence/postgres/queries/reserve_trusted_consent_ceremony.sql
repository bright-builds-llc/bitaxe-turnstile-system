INSERT INTO gate_authority.trusted_consent_ceremonies (
    ceremony_id,
    challenge_id,
    disclosure_digest_sha256,
    pool_offer_set_signature_sha256,
    reason,
    authority_origin,
    challenge_expires_at_unix_seconds,
    status,
    created_at_unix_seconds,
    expires_at_unix_seconds,
    operation_owner,
    operation_lease_expires_at_unix_seconds
)
SELECT $1, $2, $3, $4, $5, $6, $7, 'starting', $8, $9, $10::uuid, $11
FROM gate_authority.work_challenges AS challenge
WHERE challenge.challenge_id = $2
  AND (
      challenge.lifecycle_state = 'issued'
      OR ($5 = 'material_pool_terms' AND challenge.lifecycle_state = 'active')
  )
  AND challenge.expires_at_unix_seconds > $8
ON CONFLICT (challenge_id, pool_offer_set_signature_sha256, reason, authority_origin)
DO NOTHING
RETURNING *
