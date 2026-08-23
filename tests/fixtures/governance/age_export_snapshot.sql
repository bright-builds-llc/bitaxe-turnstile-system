UPDATE gate_authority.governance_export_jobs
SET created_at_unix_seconds = 100
WHERE export_id = $1::UUID
