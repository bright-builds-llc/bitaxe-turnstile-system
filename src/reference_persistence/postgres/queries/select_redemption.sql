SELECT
    record.redemption_id,
    record.action_reference,
    record.accepted_at_unix_seconds,
    outcome.status,
    outcome.safe_result,
    outcome.safe_reason
FROM relying_service.redemption_records AS record
JOIN relying_service.protected_action_outcomes AS outcome
    ON outcome.redemption_id = record.redemption_id
WHERE record.redemption_id = $1
