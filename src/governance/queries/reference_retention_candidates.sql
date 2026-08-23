WITH policy AS (
    SELECT $1::BIGINT AS as_of_unix_seconds,
           $2::BIGINT AS operational_retention_seconds,
           $3::BIGINT AS tombstone_retention_seconds
), aggregate_floors AS (
    SELECT record.redemption_id,
           GREATEST(
               outcome.terminal_at_unix_seconds + policy.operational_retention_seconds,
               record.public_lookup_expires_at_unix_seconds,
               consumption.operational_floor
           ) AS operational_floor,
           GREATEST(
               outcome.terminal_at_unix_seconds + policy.tombstone_retention_seconds,
               record.public_lookup_expires_at_unix_seconds,
               consumption.final_floor
           ) AS final_floor
    FROM redemption_records AS record
    JOIN protected_action_outcomes AS outcome USING (redemption_id)
    CROSS JOIN policy
    LEFT JOIN LATERAL (
        SELECT MAX(GREATEST(
                   marker.consumed_at_unix_seconds + policy.operational_retention_seconds,
                   marker.gate_pass_expires_at_unix_seconds
               )) AS operational_floor,
               MAX(GREATEST(
                   marker.consumed_at_unix_seconds + policy.tombstone_retention_seconds,
                   marker.gate_pass_expires_at_unix_seconds
               )) AS final_floor
        FROM pass_consumptions AS marker
        WHERE marker.redemption_id = record.redemption_id
          AND marker.gate_pass_expires_at_unix_seconds IS NOT NULL
    ) AS consumption ON TRUE
    WHERE outcome.status IN ('succeeded', 'failed')
      AND outcome.terminal_at_unix_seconds IS NOT NULL
      AND NOT EXISTS (
          SELECT 1
          FROM pass_consumptions AS unsafe_marker
          WHERE unsafe_marker.redemption_id = record.redemption_id
            AND unsafe_marker.gate_pass_expires_at_unix_seconds IS NULL
      )
)
SELECT record_key,
       retention_floor_unix_seconds,
       record_class,
       retention_state
FROM (
    SELECT proof_id AS record_key,
           expires_at_unix_seconds + 1 AS retention_floor_unix_seconds,
           'dpop_proof_replay' AS record_class,
           'identifying' AS retention_state
    FROM dpop_proofs
    CROSS JOIN policy
    WHERE expires_at_unix_seconds < policy.as_of_unix_seconds

    UNION ALL

    SELECT proof_id AS record_key,
           expires_at_unix_seconds + 1 AS retention_floor_unix_seconds,
           'claimant_outcome_proof_replay' AS record_class,
           'identifying' AS retention_state
    FROM claimant_outcome_proofs
    CROSS JOIN policy
    WHERE expires_at_unix_seconds < policy.as_of_unix_seconds

    UNION ALL

    SELECT JSON_BUILD_ARRAY(consumption.issuer, consumption.pass_id)::TEXT AS record_key,
           CASE
               WHEN GREATEST(
                   consumption.consumed_at_unix_seconds + policy.tombstone_retention_seconds,
                   consumption.gate_pass_expires_at_unix_seconds
               ) <= policy.as_of_unix_seconds
               THEN GREATEST(
                   consumption.consumed_at_unix_seconds + policy.tombstone_retention_seconds,
                   consumption.gate_pass_expires_at_unix_seconds
               )
               ELSE GREATEST(
                   consumption.consumed_at_unix_seconds + policy.operational_retention_seconds,
                   consumption.gate_pass_expires_at_unix_seconds
               )
           END AS retention_floor_unix_seconds,
           'pass_consumption' AS record_class,
           CASE
               WHEN GREATEST(
                   consumption.consumed_at_unix_seconds + policy.tombstone_retention_seconds,
                   consumption.gate_pass_expires_at_unix_seconds
               ) <= policy.as_of_unix_seconds
               THEN 'overdue_identifying'
               ELSE 'identifying'
           END AS retention_state
    FROM pass_consumptions AS consumption
    LEFT JOIN aggregate_floors AS aggregate
        ON aggregate.redemption_id = consumption.redemption_id
    CROSS JOIN policy
    WHERE consumption.gate_pass_expires_at_unix_seconds IS NOT NULL
      AND GREATEST(
          consumption.consumed_at_unix_seconds + policy.operational_retention_seconds,
          consumption.gate_pass_expires_at_unix_seconds
      ) <= policy.as_of_unix_seconds
      AND (
          aggregate.operational_floor IS NULL
          OR aggregate.operational_floor > policy.as_of_unix_seconds
      )

    UNION ALL

    SELECT aggregate.redemption_id AS record_key,
           CASE
               WHEN aggregate.final_floor <= policy.as_of_unix_seconds
               THEN aggregate.final_floor
               ELSE aggregate.operational_floor
           END AS retention_floor_unix_seconds,
           'relying_service_operational' AS record_class,
           CASE
               WHEN aggregate.final_floor <= policy.as_of_unix_seconds
               THEN 'overdue_identifying'
               ELSE 'identifying'
           END AS retention_state
    FROM aggregate_floors AS aggregate
    CROSS JOIN policy
    WHERE aggregate.operational_floor <= policy.as_of_unix_seconds

    UNION ALL

    SELECT tombstone.tombstone_id::TEXT AS record_key,
           tombstone.delete_after_unix_seconds AS retention_floor_unix_seconds,
           tombstone.record_class,
           'pseudonymized' AS retention_state
    FROM governance_tombstones AS tombstone
    CROSS JOIN policy
    WHERE tombstone.record_class IN ('pass_consumption', 'relying_service_operational')
      AND tombstone.delete_after_unix_seconds <= policy.as_of_unix_seconds
) AS candidates
ORDER BY record_class, retention_state, record_key
