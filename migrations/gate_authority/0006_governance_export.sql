CREATE TABLE gate_authority.governance_export_jobs (
    export_id UUID PRIMARY KEY,
    snapshot_cutoff_unix_seconds BIGINT NOT NULL CHECK (snapshot_cutoff_unix_seconds > 0),
    status TEXT NOT NULL CHECK (status IN ('ready', 'completed', 'failed')),
    total_items BIGINT NOT NULL CHECK (total_items >= 0),
    total_bytes BIGINT NOT NULL CHECK (total_bytes >= 0),
    content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
    counts JSONB NOT NULL,
    created_at_unix_seconds BIGINT NOT NULL CHECK (created_at_unix_seconds > 0),
    completed_at_unix_seconds BIGINT,
    CHECK (
        (status = 'ready' AND completed_at_unix_seconds IS NULL)
        OR (
            status IN ('completed', 'failed')
            AND completed_at_unix_seconds IS NOT NULL
            AND completed_at_unix_seconds >= created_at_unix_seconds
        )
    )
);

CREATE TABLE gate_authority.governance_export_items (
    export_id UUID NOT NULL REFERENCES gate_authority.governance_export_jobs(export_id),
    sequence BIGINT NOT NULL CHECK (sequence > 0),
    record_type TEXT NOT NULL CHECK (record_type <> ''),
    payload JSONB NOT NULL,
    PRIMARY KEY (export_id, sequence)
);

ALTER TABLE gate_authority.governance_audit_events
ADD COLUMN context TEXT NOT NULL DEFAULT 'gate_authority' CHECK (context = 'gate_authority'),
ADD COLUMN snapshot_cutoff_unix_seconds BIGINT CHECK (snapshot_cutoff_unix_seconds > 0);

ALTER TABLE gate_authority.governance_audit_events
ALTER COLUMN context DROP DEFAULT;
