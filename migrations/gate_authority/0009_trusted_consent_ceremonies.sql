CREATE TABLE gate_authority.trusted_consent_ceremonies (
    ceremony_id TEXT PRIMARY KEY CHECK (ceremony_id ~ '^ceremony_[A-Za-z0-9_]+$'),
    challenge_id TEXT NOT NULL REFERENCES gate_authority.work_challenges(challenge_id),
    disclosure_digest_sha256 TEXT NOT NULL CHECK (disclosure_digest_sha256 ~ '^[A-Za-z0-9_-]{43}$'),
    pool_offer_set_signature_sha256 TEXT NOT NULL CHECK (pool_offer_set_signature_sha256 ~ '^[A-Za-z0-9_-]{43}$'),
    reason TEXT NOT NULL CHECK (reason IN ('elevated_work', 'material_pool_terms')),
    authority_origin TEXT NOT NULL,
    challenge_expires_at_unix_seconds BIGINT NOT NULL,
    creation_options JSONB,
    registration_state JSONB,
    status TEXT NOT NULL CHECK (status IN ('starting', 'pending', 'verifying', 'verified', 'failed')),
    created_at_unix_seconds BIGINT NOT NULL CHECK (created_at_unix_seconds > 0),
    expires_at_unix_seconds BIGINT NOT NULL CHECK (expires_at_unix_seconds > created_at_unix_seconds),
    verified_at_unix_seconds BIGINT,
    failed_at_unix_seconds BIGINT,
    operation_owner UUID,
    operation_lease_expires_at_unix_seconds BIGINT,
    UNIQUE (
        challenge_id,
        pool_offer_set_signature_sha256,
        reason,
        authority_origin
    ),
    CHECK (
        (status = 'starting' AND verified_at_unix_seconds IS NULL
            AND failed_at_unix_seconds IS NULL AND operation_owner IS NOT NULL
            AND operation_lease_expires_at_unix_seconds IS NOT NULL
            AND creation_options IS NULL AND registration_state IS NULL)
        OR (status = 'pending' AND verified_at_unix_seconds IS NULL
            AND failed_at_unix_seconds IS NULL AND operation_owner IS NULL
            AND operation_lease_expires_at_unix_seconds IS NULL
            AND creation_options IS NOT NULL AND registration_state IS NOT NULL)
        OR (status = 'verifying' AND verified_at_unix_seconds IS NULL
            AND failed_at_unix_seconds IS NULL AND operation_owner IS NOT NULL
            AND operation_lease_expires_at_unix_seconds IS NOT NULL
            AND creation_options IS NOT NULL AND registration_state IS NOT NULL)
        OR (status = 'verified' AND verified_at_unix_seconds IS NOT NULL
            AND failed_at_unix_seconds IS NULL AND operation_owner IS NULL
            AND operation_lease_expires_at_unix_seconds IS NULL
            AND creation_options IS NULL AND registration_state IS NULL)
        OR (status = 'failed' AND verified_at_unix_seconds IS NULL
            AND failed_at_unix_seconds IS NOT NULL AND operation_owner IS NULL
            AND operation_lease_expires_at_unix_seconds IS NULL
            AND creation_options IS NULL AND registration_state IS NULL)
    ),
    CHECK (expires_at_unix_seconds <= challenge_expires_at_unix_seconds)
);

CREATE INDEX trusted_consent_pending_expiry_idx
    ON gate_authority.trusted_consent_ceremonies (expires_at_unix_seconds, ceremony_id)
    WHERE status = 'pending';

CREATE INDEX trusted_consent_starting_lease_idx
    ON gate_authority.trusted_consent_ceremonies (
        operation_lease_expires_at_unix_seconds,
        ceremony_id
    )
    WHERE status = 'starting';

CREATE INDEX trusted_consent_verification_lease_idx
    ON gate_authority.trusted_consent_ceremonies (
        operation_lease_expires_at_unix_seconds,
        ceremony_id
    )
    WHERE status = 'verifying';
