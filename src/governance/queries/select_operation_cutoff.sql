SELECT as_of_unix_seconds AS cutoff
FROM governance_retention_jobs
WHERE job_id = $1

UNION ALL

SELECT snapshot_cutoff_unix_seconds AS cutoff
FROM governance_export_jobs
WHERE export_id = $1

LIMIT 1
