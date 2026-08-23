CREATE TABLE relying_service.redemption_records (
    redemption_id TEXT PRIMARY KEY,
    audience TEXT NOT NULL,
    action_reference TEXT NOT NULL,
    claimant_jkt TEXT NOT NULL,
    protected_action_type TEXT NOT NULL,
    action_policy TEXT NOT NULL,
    accepted_at_unix_seconds BIGINT NOT NULL,
    execution_deadline_unix_seconds BIGINT NOT NULL,
    maximum_attempts INTEGER NOT NULL,
    public_lookup_expires_at_unix_seconds BIGINT NOT NULL,
    UNIQUE (audience, action_reference),
    FOREIGN KEY (audience, action_reference)
        REFERENCES relying_service.protected_actions(audience, action_reference)
);

CREATE TABLE relying_service.pass_consumptions (
    issuer TEXT NOT NULL,
    pass_id TEXT NOT NULL,
    redemption_id TEXT NOT NULL REFERENCES relying_service.redemption_records(redemption_id),
    consumed_at_unix_seconds BIGINT NOT NULL,
    PRIMARY KEY (issuer, pass_id)
);

CREATE TABLE relying_service.protected_action_outcomes (
    redemption_id TEXT PRIMARY KEY REFERENCES relying_service.redemption_records(redemption_id),
    status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
    safe_result JSONB,
    safe_reason TEXT,
    CHECK (
        (status = 'pending' AND safe_result IS NULL AND safe_reason IS NULL)
        OR (status = 'succeeded' AND safe_result IS NOT NULL AND safe_reason IS NULL)
        OR (status = 'failed' AND safe_result IS NULL AND safe_reason IS NOT NULL)
    )
);

CREATE TABLE relying_service.action_execution_intents (
    redemption_id TEXT PRIMARY KEY REFERENCES relying_service.redemption_records(redemption_id),
    status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    lease_owner TEXT,
    lease_expires_at_unix_seconds BIGINT,
    next_attempt_at_unix_seconds BIGINT NOT NULL
);

CREATE TABLE relying_service.dpop_proofs (
    proof_id TEXT PRIMARY KEY,
    expires_at_unix_seconds BIGINT NOT NULL
);

CREATE INDEX dpop_proofs_expiry ON relying_service.dpop_proofs (expires_at_unix_seconds);
