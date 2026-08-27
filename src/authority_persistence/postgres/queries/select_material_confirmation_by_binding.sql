SELECT replaced_session_id, candidate_session_id, required_signed_pool_offers,
       disclosure_digest_sha256
FROM gate_authority.pool_offer_replacements
WHERE challenge_id = $1 AND required_signature_digest_sha256 = $2
  AND status = 'pending_reconfirmation'
