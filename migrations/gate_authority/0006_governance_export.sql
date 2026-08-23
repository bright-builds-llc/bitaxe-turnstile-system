CREATE TABLE gate_authority.governance_export_jobs (
    export_id UUID PRIMARY KEY,
    snapshot_cutoff_unix_seconds BIGINT NOT NULL CHECK (snapshot_cutoff_unix_seconds > 0),
    status TEXT NOT NULL CHECK (status IN ('ready', 'completed', 'failed')),
    total_items BIGINT NOT NULL CHECK (total_items >= 0),
    total_bytes BIGINT NOT NULL CHECK (total_bytes >= 0),
    content_sha256 TEXT NOT NULL CHECK (LENGTH(content_sha256) = 64),
    counts JSONB NOT NULL,
    created_at_unix_seconds BIGINT NOT NULL,
    completed_at_unix_seconds BIGINT
);

CREATE TABLE gate_authority.governance_export_items (
    export_id UUID NOT NULL REFERENCES gate_authority.governance_export_jobs(export_id),
    sequence BIGINT NOT NULL CHECK (sequence > 0),
    line_bytes BYTEA NOT NULL,
    PRIMARY KEY (export_id, sequence)
);
