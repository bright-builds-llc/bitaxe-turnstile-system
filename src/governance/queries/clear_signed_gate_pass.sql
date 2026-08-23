UPDATE gate_pass_issuance_intents
SET gate_pass = NULL,
    gate_pass_retired_at_unix_seconds = $3
WHERE challenge_id = $1
  AND status = 'issued'
  AND gate_pass IS NOT NULL
  AND expires_at_unix_seconds = $2
  AND expires_at_unix_seconds <= $3
