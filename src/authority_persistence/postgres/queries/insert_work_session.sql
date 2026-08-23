INSERT INTO gate_authority.work_sessions (session_id, challenge_id)
SELECT $1, challenge_id
FROM gate_authority.work_challenges
WHERE challenge_id = $2
