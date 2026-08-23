WITH policy AS (
    SELECT $1::BIGINT AS as_of_unix_seconds,
           $2::BIGINT AS operational_retention_seconds,
           $3::BIGINT AS tombstone_retention_seconds
)
SELECT record_key,
       retention_floor_unix_seconds,
       record_class,
       retention_state
FROM (
    SELECT proof.proof_id AS record_key,
           proof.expires_at_unix_seconds + 1 AS retention_floor_unix_seconds,
           'claimant_issuance_proof_replay' AS record_class,
           'identifying' AS retention_state
    FROM claimant_issuance_proofs AS proof
    JOIN work_challenges AS challenge USING (challenge_id)
    CROSS JOIN policy
    WHERE proof.expires_at_unix_seconds < policy.as_of_unix_seconds
      AND (
          challenge.terminal_at_unix_seconds IS NULL
          OR challenge.terminal_at_unix_seconds + policy.operational_retention_seconds
             > policy.as_of_unix_seconds
      )

    UNION ALL

    SELECT intent.challenge_id AS record_key,
           intent.expires_at_unix_seconds AS retention_floor_unix_seconds,
           'signed_gate_pass' AS record_class,
           'identifying' AS retention_state
    FROM gate_pass_issuance_intents AS intent
    JOIN work_challenges AS challenge USING (challenge_id)
    CROSS JOIN policy
    WHERE intent.status = 'issued'
      AND intent.gate_pass IS NOT NULL
      AND intent.expires_at_unix_seconds <= policy.as_of_unix_seconds
      AND (
          challenge.terminal_at_unix_seconds IS NULL
          OR challenge.terminal_at_unix_seconds + policy.operational_retention_seconds
             > policy.as_of_unix_seconds
      )

    UNION ALL

    SELECT challenge.challenge_id AS record_key,
           CASE
               WHEN challenge.terminal_at_unix_seconds + policy.tombstone_retention_seconds
                    <= policy.as_of_unix_seconds
               THEN challenge.terminal_at_unix_seconds + policy.tombstone_retention_seconds
               ELSE challenge.terminal_at_unix_seconds + policy.operational_retention_seconds
           END AS retention_floor_unix_seconds,
           'authority_operational' AS record_class,
           CASE
               WHEN challenge.terminal_at_unix_seconds + policy.tombstone_retention_seconds
                    <= policy.as_of_unix_seconds
               THEN 'overdue_identifying'
               ELSE 'identifying'
           END AS retention_state
    FROM work_challenges AS challenge
    CROSS JOIN policy
    WHERE challenge.terminal_at_unix_seconds IS NOT NULL
      AND challenge.terminal_at_unix_seconds + policy.operational_retention_seconds
          <= policy.as_of_unix_seconds

    UNION ALL

    SELECT tombstone.tombstone_id::TEXT AS record_key,
           tombstone.delete_after_unix_seconds AS retention_floor_unix_seconds,
           'authority_operational' AS record_class,
           'pseudonymized' AS retention_state
    FROM governance_tombstones AS tombstone
    CROSS JOIN policy
    WHERE tombstone.record_class = 'authority_operational'
      AND tombstone.delete_after_unix_seconds <= policy.as_of_unix_seconds
) AS candidates
ORDER BY record_class, retention_state, record_key
