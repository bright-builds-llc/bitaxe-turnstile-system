SELECT intent.status, intent.gate_pass, intent.gate_pass_retired_at_unix_seconds
FROM gate_authority.work_challenges AS challenge
LEFT JOIN gate_authority.gate_pass_issuance_intents AS intent
    ON intent.challenge_id = challenge.challenge_id
WHERE challenge.challenge_id = $1
