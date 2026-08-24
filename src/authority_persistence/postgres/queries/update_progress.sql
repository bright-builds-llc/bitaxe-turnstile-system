UPDATE gate_authority.work_challenges
SET verified_progress = $2::numeric,
    satisfied = $3,
    lifecycle_state = CASE WHEN $3 THEN 'satisfied' ELSE lifecycle_state END,
    lifecycle_changed_at_unix_seconds = CASE WHEN $3 THEN $4 ELSE lifecycle_changed_at_unix_seconds END,
    terminal_at_unix_seconds = CASE
        WHEN $3 AND NOT EXISTS (
            SELECT 1
            FROM gate_authority.gate_pass_issuance_intents AS intent
            WHERE intent.challenge_id = $1
              AND intent.status IN ('issued', 'failed')
        ) THEN NULL
        ELSE terminal_at_unix_seconds
    END
WHERE challenge_id = $1
