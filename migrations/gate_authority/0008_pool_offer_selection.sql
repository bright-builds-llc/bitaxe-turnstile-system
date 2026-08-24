CREATE TABLE gate_authority.pool_selections (
    challenge_id TEXT PRIMARY KEY REFERENCES gate_authority.work_challenges(challenge_id),
    pool_offer_id TEXT NOT NULL CHECK (pool_offer_id ~ '^[A-Za-z0-9_-]{1,128}$'),
    payout_commitment TEXT NOT NULL CHECK (payout_commitment ~ '^[0-9a-f]{64}$'),
    status TEXT NOT NULL CHECK (status IN ('proposed', 'consented')),
    selected_at_unix_seconds BIGINT NOT NULL CHECK (selected_at_unix_seconds > 0),
    consented_at_unix_seconds BIGINT,
    UNIQUE (challenge_id, pool_offer_id, payout_commitment),
    CHECK (
        (status = 'proposed' AND consented_at_unix_seconds IS NULL)
        OR (
            status = 'consented'
            AND consented_at_unix_seconds IS NOT NULL
            AND consented_at_unix_seconds >= selected_at_unix_seconds
        )
    )
);

ALTER TABLE gate_authority.work_sessions
DROP CONSTRAINT work_session_stop_reason_shape;

ALTER TABLE gate_authority.work_sessions
ADD COLUMN pool_offer_id TEXT,
ADD COLUMN payout_commitment TEXT;

UPDATE gate_authority.work_sessions
SET lifecycle_state = 'failed',
    lease_id = NULL,
    continuity_id = NULL,
    last_monotonic_milliseconds = NULL,
    renew_at_monotonic_milliseconds = NULL,
    expires_at_monotonic_milliseconds = NULL,
    stop_reason = 'migration_pool_selection_unknown';

ALTER TABLE gate_authority.work_sessions
ADD CONSTRAINT work_session_stop_reason_shape CHECK (
    (
        lifecycle_state IN ('ready', 'leased')
        AND stop_reason IS NULL
    )
    OR (
        lifecycle_state IN ('stopping', 'restored', 'failed')
        AND stop_reason IN (
            'user_requested', 'tab_closed', 'connectivity_lost',
            'challenge_cancelled', 'challenge_expired', 'challenge_satisfied',
            'worker_reboot', 'monotonic_reset', 'uncertain_time', 'lease_expired',
            'session_failed', 'migration_continuity_unknown',
            'migration_pool_selection_unknown'
        )
    )
),
ADD CONSTRAINT work_session_pool_selection_shape CHECK (
    (
        lifecycle_state = 'failed'
        AND pool_offer_id IS NULL
        AND payout_commitment IS NULL
    )
    OR (
        pool_offer_id IS NOT NULL
        AND payout_commitment ~ '^[0-9a-f]{64}$'
    )
),
ADD CONSTRAINT work_session_pool_selection_fk FOREIGN KEY (
    challenge_id,
    pool_offer_id,
    payout_commitment
) REFERENCES gate_authority.pool_selections (
    challenge_id,
    pool_offer_id,
    payout_commitment
);

UPDATE gate_authority.gate_pass_issuance_intents AS intent
SET status = 'failed',
    signing_lease_owner = NULL,
    signing_lease_expires_at_unix_seconds = NULL
FROM gate_authority.work_challenges AS challenge
WHERE challenge.challenge_id = intent.challenge_id
  AND NOT (challenge.descriptor ? 'pool_offers')
  AND intent.status IN ('pending', 'signing');

UPDATE gate_authority.authority_outbox AS outbox
SET status = 'failed'
FROM gate_authority.work_challenges AS challenge
WHERE challenge.challenge_id = outbox.aggregate_id
  AND NOT (challenge.descriptor ? 'pool_offers')
  AND outbox.kind = 'gate_pass_signing'
  AND outbox.status IN ('pending', 'processing');

UPDATE gate_authority.work_challenges
SET lifecycle_state = 'expired',
    lifecycle_changed_at_unix_seconds = FLOOR(EXTRACT(EPOCH FROM clock_timestamp()))::BIGINT,
    terminal_at_unix_seconds = FLOOR(EXTRACT(EPOCH FROM clock_timestamp()))::BIGINT
WHERE NOT (descriptor ? 'pool_offers')
  AND lifecycle_state IN ('issued', 'active', 'satisfied');
