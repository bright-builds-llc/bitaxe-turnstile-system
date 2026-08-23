SELECT record_type, source_key, payload
FROM (
    SELECT 'challenge_summary' AS record_type,
           challenge_id AS source_key,
           JSONB_BUILD_OBJECT(
               'verified_progress', verified_progress::TEXT,
               'work_requirement', work_requirement::TEXT,
               'satisfied', satisfied,
               'expires_at_unix_seconds', expires_at_unix_seconds,
               'terminal_at_unix_seconds', terminal_at_unix_seconds
           ) AS payload
    FROM work_challenges
    WHERE expires_at_unix_seconds <= $1
       OR terminal_at_unix_seconds <= $1

    UNION ALL

    SELECT 'issuance_summary' AS record_type,
           challenge_id || ':issuance' AS source_key,
           JSONB_BUILD_OBJECT(
               'status', status,
               'issued_at_unix_seconds', issued_at_unix_seconds,
               'expires_at_unix_seconds', expires_at_unix_seconds,
               'material_retired', gate_pass_retired_at_unix_seconds IS NOT NULL
           ) AS payload
    FROM gate_pass_issuance_intents
    WHERE signing_deadline_unix_seconds <= $1
       OR issued_at_unix_seconds <= $1

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
