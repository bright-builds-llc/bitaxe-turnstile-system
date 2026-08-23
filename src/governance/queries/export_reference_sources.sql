SELECT record_type, source_key, payload
FROM (
    SELECT 'redemption_outcome_summary' AS record_type,
           record.redemption_id AS source_key,
           JSONB_BUILD_OBJECT(
               'protected_action_type', record.protected_action_type,
               'action_policy', record.action_policy,
               'accepted_at_unix_seconds', record.accepted_at_unix_seconds,
               'public_lookup_expires_at_unix_seconds',
                   record.public_lookup_expires_at_unix_seconds,
               'outcome_status', outcome.status,
               'terminal_at_unix_seconds', outcome.terminal_at_unix_seconds
           ) AS payload
    FROM redemption_records AS record
    JOIN protected_action_outcomes AS outcome USING (redemption_id)
    WHERE record.accepted_at_unix_seconds <= $1

    UNION ALL

    SELECT 'pass_consumption_summary' AS record_type,
           JSON_BUILD_ARRAY(issuer, pass_id)::TEXT AS source_key,
           JSONB_BUILD_OBJECT(
               'consumed_at_unix_seconds', consumed_at_unix_seconds,
               'gate_pass_expires_at_unix_seconds', gate_pass_expires_at_unix_seconds
           ) AS payload
    FROM pass_consumptions
    WHERE consumed_at_unix_seconds <= $1

    UNION ALL

    SELECT 'governance_tombstone' AS record_type,
           pseudonym AS source_key,
           JSONB_BUILD_OBJECT(
               'record_pseudonym', pseudonym,
               'record_class', record_class,
               'terminal_status', terminal_status,
               'protected_action_type', protected_action_type,
               'action_policy', action_policy,
               'terminal_at_unix_seconds', terminal_at_unix_seconds,
               'pseudonymized_at_unix_seconds', pseudonymized_at_unix_seconds,
               'delete_after_unix_seconds', delete_after_unix_seconds
           ) AS payload
    FROM governance_tombstones
    WHERE pseudonymized_at_unix_seconds <= $1

    UNION ALL

    SELECT 'governance_audit_event' AS record_type,
           event_id::TEXT AS source_key,
           JSONB_BUILD_OBJECT(
               'event_type', event_type,
               'manifest_digest', manifest_digest,
               'occurred_at_unix_seconds', occurred_at_unix_seconds,
               'counts', counts,
               'duration_milliseconds', duration_milliseconds,
               'outcome', outcome,
               'error_category', error_category
           ) AS payload
    FROM governance_audit_events
    WHERE occurred_at_unix_seconds <= $1
) AS sources
ORDER BY record_type, source_key
