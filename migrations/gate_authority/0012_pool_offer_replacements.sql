CREATE TABLE gate_authority.pool_offer_replacements (
    replaced_session_id TEXT PRIMARY KEY REFERENCES gate_authority.work_sessions(session_id),
    candidate_session_id TEXT NOT NULL UNIQUE,
    challenge_id TEXT NOT NULL REFERENCES gate_authority.work_challenges(challenge_id),
    status TEXT NOT NULL CHECK (status IN ('equivalent', 'pending_reconfirmation')),
    prior_offer JSONB NOT NULL,
    candidate_offer JSONB NOT NULL,
    candidate_signature TEXT NOT NULL CHECK (candidate_signature <> ''),
    candidate_set_digest TEXT NOT NULL CHECK (candidate_set_digest ~ '^[A-Za-z0-9_-]{43}$'),
    change JSONB NOT NULL,
    decided_at_unix_seconds BIGINT NOT NULL CHECK (decided_at_unix_seconds > 0)
);
