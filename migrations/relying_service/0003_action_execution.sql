CREATE TABLE relying_service.action_execution_attempts (
    attempt_id TEXT PRIMARY KEY,
    redemption_id TEXT NOT NULL REFERENCES relying_service.redemption_records(redemption_id),
    attempt_number INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('processing', 'succeeded', 'abandoned')),
    started_at_unix_seconds BIGINT NOT NULL,
    completed_at_unix_seconds BIGINT,
    UNIQUE (redemption_id, attempt_number)
);

CREATE TABLE relying_service.reference_accounts (
    account_id TEXT PRIMARY KEY,
    action_reference TEXT NOT NULL UNIQUE
);
