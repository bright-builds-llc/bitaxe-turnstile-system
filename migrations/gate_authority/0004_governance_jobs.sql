CREATE TABLE gate_authority.governance_retention_jobs (
    job_id UUID PRIMARY KEY,
    manifest_digest TEXT NOT NULL,
    as_of_unix_seconds BIGINT NOT NULL CHECK (as_of_unix_seconds > 0),
    policy JSONB NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('planned', 'applying', 'completed', 'failed')),
    cursor BIGINT NOT NULL DEFAULT 0 CHECK (cursor >= 0),
    eligible_items BIGINT NOT NULL CHECK (eligible_items >= 0),
    created_at_unix_seconds BIGINT NOT NULL,
    completed_at_unix_seconds BIGINT
);

CREATE TABLE gate_authority.governance_retention_items (
    job_id UUID NOT NULL REFERENCES gate_authority.governance_retention_jobs(job_id),
    sequence BIGINT NOT NULL CHECK (sequence > 0),
    record_class TEXT NOT NULL,
    record_key TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('pseudonymize', 'delete')),
    eligibility_reason TEXT NOT NULL,
    retention_floor_unix_seconds BIGINT NOT NULL,
    PRIMARY KEY (job_id, sequence)
);

CREATE TABLE gate_authority.governance_tombstones (
    tombstone_id UUID PRIMARY KEY,
    record_class TEXT NOT NULL,
    pseudonym TEXT NOT NULL,
    terminal_status TEXT,
    protected_action_type TEXT,
    action_policy TEXT,
    terminal_at_unix_seconds BIGINT NOT NULL,
    pseudonymized_at_unix_seconds BIGINT NOT NULL,
    delete_after_unix_seconds BIGINT NOT NULL,
    UNIQUE (record_class, pseudonym)
);

CREATE TABLE gate_authority.governance_audit_events (
    event_id UUID PRIMARY KEY,
    event_type TEXT NOT NULL,
    operation_id UUID NOT NULL,
    manifest_digest TEXT,
    occurred_at_unix_seconds BIGINT NOT NULL,
    counts JSONB NOT NULL,
    duration_milliseconds BIGINT NOT NULL CHECK (duration_milliseconds >= 0),
    outcome TEXT NOT NULL,
    error_category TEXT
);
