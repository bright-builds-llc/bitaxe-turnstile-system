SELECT proof_id AS record_key,
       expires_at_unix_seconds,
       'claimant_issuance_proof_replay' AS record_class
FROM claimant_issuance_proofs
WHERE expires_at_unix_seconds < $1
ORDER BY record_class, record_key
