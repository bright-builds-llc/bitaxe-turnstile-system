INSERT INTO governance_tombstones (
    tombstone_id,
    record_class,
    pseudonym,
    terminal_status,
    terminal_at_unix_seconds,
    pseudonymized_at_unix_seconds,
    delete_after_unix_seconds
)
VALUES (
    $1,
    'authority_operational',
    $2,
    $3,
    $4,
    $5,
    $6
)
