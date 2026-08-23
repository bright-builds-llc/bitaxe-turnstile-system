WITH deleted_items AS (
    DELETE FROM governance_export_items
    WHERE export_id = $1
)
DELETE FROM governance_export_jobs
WHERE export_id = $1
  AND created_at_unix_seconds = $2
  AND created_at_unix_seconds < $3
