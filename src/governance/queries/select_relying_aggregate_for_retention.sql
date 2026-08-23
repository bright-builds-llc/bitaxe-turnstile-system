SELECT record.audience,
       record.action_reference,
       record.protected_action_type,
       record.action_policy,
       record.public_lookup_expires_at_unix_seconds,
       outcome.status AS terminal_status,
       outcome.terminal_at_unix_seconds
FROM redemption_records AS record
JOIN protected_action_outcomes AS outcome USING (redemption_id)
WHERE record.redemption_id = $1
  AND outcome.status IN ('succeeded', 'failed')
  AND outcome.terminal_at_unix_seconds IS NOT NULL
FOR UPDATE OF record, outcome
