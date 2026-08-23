WITH target AS (
    SELECT audience, action_reference
    FROM redemption_records
    WHERE redemption_id = $1
), deleted_consumptions AS (
    DELETE FROM pass_consumptions
    WHERE redemption_id = $1
), deleted_attempts AS (
    DELETE FROM action_execution_attempts
    WHERE redemption_id = $1
), deleted_intent AS (
    DELETE FROM action_execution_intents
    WHERE redemption_id = $1
), deleted_outcome AS (
    DELETE FROM protected_action_outcomes
    WHERE redemption_id = $1
), deleted_redemption AS (
    DELETE FROM redemption_records
    WHERE redemption_id = $1
)
DELETE FROM protected_actions AS action
USING target
WHERE action.audience = target.audience
  AND action.action_reference = target.action_reference
