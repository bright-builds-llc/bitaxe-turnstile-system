DELETE FROM governance_tombstones
WHERE tombstone_id = $1
  AND record_class = 'authority_operational'
  AND delete_after_unix_seconds = $2
  AND delete_after_unix_seconds <= $3
