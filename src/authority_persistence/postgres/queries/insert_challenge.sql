INSERT INTO gate_authority.work_challenges (
    challenge_id,
    descriptor,
    work_requirement,
    expires_at_unix_seconds,
    terminal_at_unix_seconds,
    gate_pass_claims_seed,
    trusted_confirmation_required
)
VALUES ($1, $2, $3::numeric, $4, $4, $5, $6)
