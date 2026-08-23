UPDATE gate_authority.gate_pass_issuance_intents
SET status = 'issued',
    authority_kid = 'authority-a',
    gate_pass = 'signed-pass-public-retention',
    issued_at_unix_seconds = $2,
    expires_at_unix_seconds = $3
WHERE challenge_id = $1
