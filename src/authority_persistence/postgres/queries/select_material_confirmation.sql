SELECT replaced_session_id, candidate_session_id, required_signed_pool_offers,
       disclosure_digest_sha256
FROM gate_authority.pool_offer_replacements
WHERE replaced_session_id = $1 AND required_signed_pool_offers IS NOT NULL
