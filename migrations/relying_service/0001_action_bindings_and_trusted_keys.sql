CREATE SCHEMA IF NOT EXISTS relying_service;

CREATE TABLE relying_service.trusted_authority_keys (
    issuer TEXT NOT NULL,
    kid TEXT NOT NULL,
    jwk JSONB NOT NULL,
    PRIMARY KEY (issuer, kid)
);

CREATE TABLE relying_service.protected_actions (
    audience TEXT NOT NULL,
    action_reference TEXT NOT NULL,
    claimant_jkt TEXT NOT NULL,
    protected_action_type TEXT NOT NULL,
    action_policy TEXT NOT NULL,
    execution_timeout_seconds BIGINT NOT NULL CHECK (execution_timeout_seconds > 0),
    maximum_attempts INTEGER NOT NULL CHECK (maximum_attempts > 0),
    retryable_error_classes JSONB NOT NULL,
    created_at_unix_seconds BIGINT NOT NULL,
    PRIMARY KEY (audience, action_reference)
);
