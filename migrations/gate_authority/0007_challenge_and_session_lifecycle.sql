ALTER TABLE gate_authority.work_challenges
ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'issued' CHECK (
    lifecycle_state IN ('issued', 'active', 'satisfied', 'pass_issued', 'cancelled', 'expired')
),
ADD COLUMN lifecycle_changed_at_unix_seconds BIGINT CHECK (
    lifecycle_changed_at_unix_seconds IS NULL OR lifecycle_changed_at_unix_seconds > 0
);

UPDATE gate_authority.work_challenges AS challenge
SET lifecycle_state = CASE
    WHEN intent.status = 'issued' THEN 'pass_issued'
    WHEN intent.status = 'failed' THEN 'expired'
    WHEN challenge.satisfied THEN 'satisfied'
    WHEN EXISTS (
        SELECT 1
        FROM gate_authority.accepted_work_events AS event
        WHERE event.challenge_id = challenge.challenge_id
    ) THEN 'active'
    ELSE 'issued'
END
FROM gate_authority.gate_pass_issuance_intents AS intent
WHERE intent.challenge_id = challenge.challenge_id;

UPDATE gate_authority.work_challenges
SET lifecycle_state = 'satisfied'
WHERE satisfied AND lifecycle_state = 'issued';

UPDATE gate_authority.work_challenges AS challenge
SET lifecycle_state = 'active'
WHERE lifecycle_state = 'issued'
  AND EXISTS (
      SELECT 1
      FROM gate_authority.accepted_work_events AS event
      WHERE event.challenge_id = challenge.challenge_id
  );

ALTER TABLE gate_authority.work_sessions
ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'ready' CHECK (
    lifecycle_state IN ('ready', 'leased', 'stopping', 'restored', 'failed')
),
ADD COLUMN lease_id UUID,
ADD COLUMN continuity_id TEXT,
ADD COLUMN last_monotonic_milliseconds BIGINT,
ADD COLUMN renew_at_monotonic_milliseconds BIGINT,
ADD COLUMN expires_at_monotonic_milliseconds BIGINT,
ADD COLUMN stop_reason TEXT,
ADD CONSTRAINT work_session_lease_shape CHECK (
    (
        lifecycle_state = 'leased'
        AND lease_id IS NOT NULL
        AND continuity_id IS NOT NULL
        AND last_monotonic_milliseconds IS NOT NULL
        AND renew_at_monotonic_milliseconds IS NOT NULL
        AND expires_at_monotonic_milliseconds IS NOT NULL
        AND last_monotonic_milliseconds >= 0
        AND renew_at_monotonic_milliseconds > last_monotonic_milliseconds
        AND expires_at_monotonic_milliseconds > renew_at_monotonic_milliseconds
    )
    OR (
        lifecycle_state <> 'leased'
        AND lease_id IS NULL
        AND continuity_id IS NULL
        AND last_monotonic_milliseconds IS NULL
        AND renew_at_monotonic_milliseconds IS NULL
        AND expires_at_monotonic_milliseconds IS NULL
    )
),
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
            'session_failed', 'migration_continuity_unknown'
        )
    )
);

UPDATE gate_authority.work_sessions AS session
SET lifecycle_state = 'failed', stop_reason = 'migration_continuity_unknown';

CREATE INDEX work_sessions_challenge_lifecycle
ON gate_authority.work_sessions (challenge_id, lifecycle_state);
