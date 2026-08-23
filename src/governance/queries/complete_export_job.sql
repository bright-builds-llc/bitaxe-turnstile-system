UPDATE governance_export_jobs
SET status = 'completed',
    completed_at_unix_seconds = FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT
WHERE export_id = $1 AND status = 'ready'
