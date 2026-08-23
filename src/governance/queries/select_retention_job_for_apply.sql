SELECT manifest_digest,
       as_of_unix_seconds,
       policy,
       status,
       cursor,
       eligible_items
FROM governance_retention_jobs
WHERE job_id = $1
FOR UPDATE
