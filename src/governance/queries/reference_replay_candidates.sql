WITH policy AS (
    SELECT $1::BIGINT AS as_of_unix_seconds,
           $2::BIGINT AS operational_retention_seconds,
           $3::BIGINT AS tombstone_retention_seconds
)
SELECT proof_id AS record_key,
       expires_at_unix_seconds + 1 AS retention_floor_unix_seconds,
       record_class,
       'identifying' AS retention_state
FROM (
    SELECT proof_id,
           expires_at_unix_seconds,
           'dpop_proof_replay' AS record_class
    FROM dpop_proofs
    CROSS JOIN policy
    WHERE expires_at_unix_seconds < policy.as_of_unix_seconds

    UNION ALL

    SELECT proof_id,
           expires_at_unix_seconds,
           'claimant_outcome_proof_replay' AS record_class
    FROM claimant_outcome_proofs
    CROSS JOIN policy
    WHERE expires_at_unix_seconds < policy.as_of_unix_seconds
) AS replay_material
ORDER BY record_class, record_key
