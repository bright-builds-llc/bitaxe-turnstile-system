-- A refused event is settled once with its reason and never delivered again, and an
-- outage waits for next_attempt_at before another claim (ADR-0108).
-- acknowledged_at_unix_seconds is the settlement time for both outcomes.
ALTER TABLE pool_adapter.accepted_work_outbox
    DROP CONSTRAINT accepted_work_outbox_delivery_state_check,
    DROP CONSTRAINT accepted_work_outbox_check1,
    ADD COLUMN refusal_reason TEXT CHECK (refusal_reason ~ '^[a-z_]{1,64}$'),
    ADD COLUMN next_attempt_at_unix_seconds BIGINT CHECK (next_attempt_at_unix_seconds > 0),
    ADD CONSTRAINT accepted_work_outbox_delivery_state_check CHECK (
        delivery_state IN ('pending', 'acknowledged', 'refused')
    ),
    ADD CONSTRAINT accepted_work_outbox_settlement_check CHECK (
        (
            delivery_state = 'pending'
            AND acknowledged_at_unix_seconds IS NULL
            AND refusal_reason IS NULL
            AND (
                (delivery_owner IS NULL AND delivery_lease_expires_at_unix_seconds IS NULL)
                OR (
                    delivery_owner IS NOT NULL
                    AND delivery_lease_expires_at_unix_seconds IS NOT NULL
                )
            )
        )
        OR (
            delivery_state IN ('acknowledged', 'refused')
            AND acknowledged_at_unix_seconds IS NOT NULL
            AND (refusal_reason IS NOT NULL) = (delivery_state = 'refused')
            AND delivery_owner IS NULL
            AND delivery_lease_expires_at_unix_seconds IS NULL
            AND next_attempt_at_unix_seconds IS NULL
        )
    );
