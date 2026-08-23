UPDATE gate_authority.work_challenges
SET satisfied = TRUE,
    verified_progress = work_requirement,
    terminal_at_unix_seconds = $2
WHERE challenge_id = $1
