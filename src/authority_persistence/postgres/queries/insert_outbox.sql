INSERT INTO gate_authority.authority_outbox (
    outbox_id,
    aggregate_id,
    kind,
    status,
    available_at_unix_seconds
)
VALUES ($1, $2, 'gate_pass_signing', 'pending', $3)
