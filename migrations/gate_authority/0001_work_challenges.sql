CREATE SCHEMA IF NOT EXISTS gate_authority;

CREATE TABLE gate_authority.work_challenges (
    challenge_id TEXT PRIMARY KEY,
    descriptor JSONB NOT NULL,
    gate_pass_claims_seed JSONB NOT NULL,
    work_requirement NUMERIC(78, 0) NOT NULL CHECK (work_requirement > 0),
    verified_progress NUMERIC(78, 0) NOT NULL DEFAULT 0 CHECK (verified_progress >= 0),
    satisfied BOOLEAN NOT NULL DEFAULT FALSE,
    expires_at_unix_seconds BIGINT NOT NULL CHECK (expires_at_unix_seconds > 0)
);
