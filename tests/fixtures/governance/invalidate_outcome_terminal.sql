UPDATE relying_service.protected_action_outcomes
SET terminal_at_unix_seconds = 0
WHERE redemption_id = 'redemption_retention'
