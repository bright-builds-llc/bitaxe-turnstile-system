INSERT INTO gate_authority.accepted_work_events (
    event_id,
    challenge_id,
    session_id,
    assigned_target,
    received_at_unix_seconds,
    share_fingerprint,
    network_target_outcome,
    disposition,
    credited_work,
    verified_progress,
    work_requirement,
    issuance_intent_created
)
VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8,
    $9::numeric, $10::numeric, $11::numeric, $12
)
