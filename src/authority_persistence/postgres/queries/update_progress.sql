UPDATE gate_authority.work_challenges
SET verified_progress = $2::numeric, satisfied = $3
WHERE challenge_id = $1
