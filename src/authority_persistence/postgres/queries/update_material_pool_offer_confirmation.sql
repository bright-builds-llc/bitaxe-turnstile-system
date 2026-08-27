UPDATE gate_authority.pool_offer_replacements
SET required_signed_pool_offers = COALESCE(required_signed_pool_offers, $2),
    disclosure_digest_sha256 = COALESCE(disclosure_digest_sha256, $3),
    required_signature_digest_sha256 = COALESCE(required_signature_digest_sha256, $4)
WHERE replaced_session_id = $1 AND status = 'pending_reconfirmation'
RETURNING replaced_session_id, candidate_session_id, required_signed_pool_offers,
          disclosure_digest_sha256
