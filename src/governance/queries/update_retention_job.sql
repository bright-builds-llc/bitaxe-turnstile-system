UPDATE governance_retention_jobs
SET status = $2,
    cursor = $3,
    completed_at_unix_seconds = CASE
        WHEN $2 = 'completed' THEN FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT
        ELSE NULL
    END
WHERE job_id = $1
