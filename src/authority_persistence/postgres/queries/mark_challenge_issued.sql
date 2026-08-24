UPDATE gate_authority.work_challenges
SET terminal_at_unix_seconds = $2,
    lifecycle_state = 'pass_issued',
    lifecycle_changed_at_unix_seconds = $2
WHERE challenge_id = $1
