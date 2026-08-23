INSERT INTO governance_retention_items (
    job_id,
    sequence,
    record_class,
    record_key,
    action,
    eligibility_reason,
    retention_floor_unix_seconds
)
VALUES ($1, $2, $3, $4, $5, $6, $7)
