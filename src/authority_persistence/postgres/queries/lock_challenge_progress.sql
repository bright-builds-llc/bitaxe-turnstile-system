SELECT
    work_requirement::text AS work_requirement,
    verified_progress::text AS verified_progress,
    satisfied,
    lifecycle_state,
    expires_at_unix_seconds,
    gate_pass_claims_seed
FROM gate_authority.work_challenges
WHERE challenge_id = $1
FOR UPDATE
