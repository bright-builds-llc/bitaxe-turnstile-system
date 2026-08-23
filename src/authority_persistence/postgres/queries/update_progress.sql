UPDATE gate_authority.work_challenges
SET verified_progress = $2::numeric,
    satisfied = $3,
    terminal_at_unix_seconds = CASE
        WHEN $3 THEN NULL
        ELSE terminal_at_unix_seconds
    END
WHERE challenge_id = $1
