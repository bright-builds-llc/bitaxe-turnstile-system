SELECT challenge.terminal_at_unix_seconds,
       COALESCE(intent.status, 'expired') AS terminal_status
FROM work_challenges AS challenge
LEFT JOIN gate_pass_issuance_intents AS intent USING (challenge_id)
WHERE challenge.challenge_id = $1
  AND challenge.terminal_at_unix_seconds = $2
  AND challenge.terminal_at_unix_seconds + $3 = $4
  AND $4 <= $5
  AND (intent.status IN ('issued', 'failed') OR intent.status IS NULL)
FOR UPDATE OF challenge
