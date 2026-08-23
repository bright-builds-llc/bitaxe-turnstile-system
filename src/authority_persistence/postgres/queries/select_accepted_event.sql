SELECT
    event_id,
    challenge_id,
    session_id,
    assigned_target,
    received_at_unix_seconds,
    share_fingerprint,
    network_target_outcome,
    disposition,
    credited_work::text AS credited_work,
    verified_progress::text AS verified_progress,
    work_requirement::text AS work_requirement,
    issuance_intent_created
FROM gate_authority.accepted_work_events
WHERE event_id = $1
