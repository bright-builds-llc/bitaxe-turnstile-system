DELETE FROM governance_audit_events
WHERE event_id = $1
  AND occurred_at_unix_seconds = $2
  AND occurred_at_unix_seconds < $3
