SELECT proof_id AS record_key,
       expires_at_unix_seconds,
       record_class
FROM (
    SELECT proof_id,
           expires_at_unix_seconds,
           'dpop_proof_replay' AS record_class
    FROM dpop_proofs
    WHERE expires_at_unix_seconds < $1

    UNION ALL

    SELECT proof_id,
           expires_at_unix_seconds,
           'claimant_outcome_proof_replay' AS record_class
    FROM claimant_outcome_proofs
    WHERE expires_at_unix_seconds < $1
) AS replay_material
ORDER BY record_class, record_key
