SELECT
    challenge_id,
    verified_progress::text,
    work_requirement::text
FROM gate_authority.work_challenges
WHERE challenge_id = $1
