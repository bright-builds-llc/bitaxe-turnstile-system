ALTER TABLE relying_service.pass_consumptions
ADD COLUMN gate_pass_expires_at_unix_seconds BIGINT;

ALTER TABLE relying_service.pass_consumptions
ADD CONSTRAINT pass_consumption_retention_floor CHECK (
    gate_pass_expires_at_unix_seconds IS NULL
    OR gate_pass_expires_at_unix_seconds > consumed_at_unix_seconds
);

CREATE INDEX pass_consumptions_expiry
ON relying_service.pass_consumptions (gate_pass_expires_at_unix_seconds)
WHERE gate_pass_expires_at_unix_seconds IS NOT NULL;

ALTER TABLE relying_service.protected_action_outcomes
ADD COLUMN terminal_at_unix_seconds BIGINT;

UPDATE relying_service.protected_action_outcomes AS outcome
SET terminal_at_unix_seconds = completed.completed_at_unix_seconds
FROM (
    SELECT redemption_id, MAX(completed_at_unix_seconds) AS completed_at_unix_seconds
    FROM relying_service.action_execution_attempts
    WHERE completed_at_unix_seconds IS NOT NULL
    GROUP BY redemption_id
) AS completed
WHERE outcome.redemption_id = completed.redemption_id
  AND outcome.status IN ('succeeded', 'failed');

ALTER TABLE relying_service.protected_action_outcomes
ADD CONSTRAINT protected_action_outcome_terminal_positive CHECK (
    terminal_at_unix_seconds IS NULL OR terminal_at_unix_seconds > 0
);

CREATE INDEX protected_action_outcomes_terminal_at
ON relying_service.protected_action_outcomes (terminal_at_unix_seconds)
WHERE terminal_at_unix_seconds IS NOT NULL;

ALTER TABLE relying_service.governance_tombstones
ADD CONSTRAINT governance_tombstone_time_order CHECK (
    terminal_at_unix_seconds > 0
    AND pseudonymized_at_unix_seconds >= terminal_at_unix_seconds
    AND delete_after_unix_seconds >= pseudonymized_at_unix_seconds
);
