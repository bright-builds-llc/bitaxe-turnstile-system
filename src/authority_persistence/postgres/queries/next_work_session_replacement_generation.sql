SELECT COALESCE(MAX(replacement_generation), 0) + 1
FROM gate_authority.work_sessions
WHERE challenge_id = $1
