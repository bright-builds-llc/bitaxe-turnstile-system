INSERT INTO gate_authority.work_sessions (session_id, challenge_id)
VALUES ('session_authority_retention', 'challenge_authority_retention');

INSERT INTO gate_authority.share_fingerprints (share_fingerprint, challenge_id)
VALUES ('share_authority_retention', 'challenge_authority_retention');

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
    issuance_intent_created,
    acknowledgement_ready
)
VALUES (
    'event_authority_retention',
    'challenge_authority_retention',
    'session_authority_retention',
    DECODE(REPEAT('01', 32), 'hex'),
    100,
    'share_authority_retention',
    'below_network_target',
    'challenge_satisfied',
    1,
    1,
    1,
    TRUE,
    TRUE
);

INSERT INTO gate_authority.authority_outbox (
    outbox_id,
    aggregate_id,
    kind,
    status,
    available_at_unix_seconds
)
VALUES (
    '00000000-0000-4000-8000-000000000001',
    'challenge_authority_retention',
    'gate_pass_signing',
    'completed',
    100
);
