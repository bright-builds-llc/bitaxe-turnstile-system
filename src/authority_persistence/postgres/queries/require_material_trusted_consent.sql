UPDATE gate_authority.work_sessions
SET material_trusted_confirmation_required = TRUE
WHERE session_id = $1
