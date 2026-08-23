SELECT sequence, line_bytes
FROM governance_export_items
WHERE export_id = $1 AND sequence > $2
ORDER BY sequence
LIMIT $3
