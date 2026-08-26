ALTER TABLE gate_authority.trusted_consent_ceremonies
    ADD COLUMN trusted_consent_receipt TEXT,
    ADD COLUMN receipt_issued_at_unix_seconds BIGINT,
    ADD COLUMN receipt_expires_at_unix_seconds BIGINT;

ALTER TABLE gate_authority.trusted_consent_ceremonies
    ADD CONSTRAINT trusted_consent_receipt_state_check CHECK (
        (trusted_consent_receipt IS NULL AND receipt_issued_at_unix_seconds IS NULL
            AND receipt_expires_at_unix_seconds IS NULL)
        OR (status = 'verified'
            AND trusted_consent_receipt ~ '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
            AND receipt_issued_at_unix_seconds = verified_at_unix_seconds
            AND receipt_expires_at_unix_seconds = challenge_expires_at_unix_seconds)
    );

ALTER TABLE gate_authority.trusted_consent_ceremonies
    DROP CONSTRAINT trusted_consent_ceremonies_challenge_id_fkey,
    ADD CONSTRAINT trusted_consent_ceremonies_challenge_id_fkey
        FOREIGN KEY (challenge_id)
        REFERENCES gate_authority.work_challenges(challenge_id) ON DELETE CASCADE;

ALTER TABLE gate_authority.work_challenges
    ADD COLUMN trusted_confirmation_required BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE gate_authority.work_challenges
SET trusted_confirmation_required = TRUE
WHERE descriptor ->> 'action_policy' = 'account-creation.elevated.v1';

ALTER TABLE gate_authority.work_sessions
    ADD COLUMN trusted_consent_ceremony_id TEXT
        REFERENCES gate_authority.trusted_consent_ceremonies(ceremony_id) ON DELETE SET NULL;

CREATE UNIQUE INDEX work_session_trusted_consent_once_idx
    ON gate_authority.work_sessions (trusted_consent_ceremony_id)
    WHERE trusted_consent_ceremony_id IS NOT NULL;
