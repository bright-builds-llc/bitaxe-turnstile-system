SELECT sequence,
       record_class,
       record_key,
       action,
       eligibility_reason,
       retention_floor_unix_seconds
FROM governance_retention_items
WHERE job_id = $1
ORDER BY sequence
