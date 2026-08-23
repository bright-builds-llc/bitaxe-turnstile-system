CREATE TABLE gate_authority.work_sessions (
    session_id TEXT PRIMARY KEY,
    challenge_id TEXT NOT NULL REFERENCES gate_authority.work_challenges(challenge_id)
);

CREATE TABLE gate_authority.share_fingerprints (
    share_fingerprint TEXT PRIMARY KEY,
    challenge_id TEXT NOT NULL REFERENCES gate_authority.work_challenges(challenge_id)
);

CREATE TABLE gate_authority.gate_pass_issuance_intents (
    challenge_id TEXT PRIMARY KEY REFERENCES gate_authority.work_challenges(challenge_id),
    pass_id TEXT NOT NULL UNIQUE,
    algorithm TEXT NOT NULL,
    claims_template JSONB NOT NULL,
    signing_deadline_unix_seconds BIGINT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'signing', 'issued', 'failed')),
    signing_lease_owner TEXT,
    signing_lease_expires_at_unix_seconds BIGINT,
    authority_kid TEXT,
    gate_pass TEXT,
    issued_at_unix_seconds BIGINT,
    expires_at_unix_seconds BIGINT,
    CHECK ((status = 'issued') = (gate_pass IS NOT NULL))
);

CREATE TABLE gate_authority.authority_outbox (
    outbox_id UUID PRIMARY KEY,
    aggregate_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    available_at_unix_seconds BIGINT NOT NULL,
    UNIQUE (aggregate_id, kind)
);

CREATE TABLE gate_authority.accepted_work_events (
    event_id TEXT PRIMARY KEY,
    challenge_id TEXT NOT NULL REFERENCES gate_authority.work_challenges(challenge_id),
    session_id TEXT NOT NULL REFERENCES gate_authority.work_sessions(session_id),
    assigned_target BYTEA NOT NULL,
    received_at_unix_seconds BIGINT NOT NULL,
    share_fingerprint TEXT NOT NULL,
    network_target_outcome TEXT NOT NULL CHECK (
        network_target_outcome IN ('below_network_target', 'network_target_met')
    ),
    disposition TEXT NOT NULL CHECK (
        disposition IN ('credited', 'duplicate_share', 'challenge_satisfied')
    ),
    credited_work NUMERIC(78, 0),
    verified_progress NUMERIC(78, 0) NOT NULL,
    work_requirement NUMERIC(78, 0) NOT NULL,
    issuance_intent_created BOOLEAN NOT NULL,
    acknowledgement_ready BOOLEAN NOT NULL DEFAULT TRUE
);
