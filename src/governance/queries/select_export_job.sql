SELECT snapshot_cutoff_unix_seconds,
       status,
       total_items,
       total_bytes,
       content_sha256,
       counts
FROM governance_export_jobs
WHERE export_id = $1
