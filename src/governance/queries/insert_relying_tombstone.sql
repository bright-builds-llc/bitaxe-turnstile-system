INSERT INTO governance_tombstones (
    tombstone_id,
    record_class,
    pseudonym,
    terminal_status,
    protected_action_type,
    action_policy,
    terminal_at_unix_seconds,
    pseudonymized_at_unix_seconds,
    delete_after_unix_seconds
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
