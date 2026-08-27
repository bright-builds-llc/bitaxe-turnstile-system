SELECT session_id, replaces_session_id, replacement_generation, replacement_reason
FROM gate_authority.work_sessions
WHERE replaces_session_id = $1
