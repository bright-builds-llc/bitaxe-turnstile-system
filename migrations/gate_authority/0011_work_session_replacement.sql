ALTER TABLE gate_authority.work_sessions
DROP CONSTRAINT work_session_stop_reason_shape;

ALTER TABLE gate_authority.work_sessions
ADD COLUMN replaces_session_id TEXT REFERENCES gate_authority.work_sessions(session_id),
ADD COLUMN replacement_generation BIGINT NOT NULL DEFAULT 0 CHECK (replacement_generation >= 0),
ADD COLUMN replacement_reason TEXT,
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
            'transport_disconnected', 'session_failed', 'migration_continuity_unknown',
            'migration_pool_selection_unknown'
        )
    )
),
ADD CONSTRAINT work_session_replacement_shape CHECK (
    (
        replacement_generation = 0
        AND replaces_session_id IS NULL
        AND replacement_reason IS NULL
    )
    OR (
        replacement_generation > 0
        AND replaces_session_id IS NOT NULL
        AND replacement_reason IN (
            'worker_reboot', 'monotonic_reset', 'uncertain_time', 'lease_expired',
            'transport_disconnected', 'session_failed'
        )
    )
);

CREATE UNIQUE INDEX work_session_replaces_once_idx
ON gate_authority.work_sessions (replaces_session_id)
WHERE replaces_session_id IS NOT NULL;

CREATE UNIQUE INDEX work_session_replacement_generation_idx
ON gate_authority.work_sessions (challenge_id, replacement_generation)
WHERE replacement_generation > 0;
