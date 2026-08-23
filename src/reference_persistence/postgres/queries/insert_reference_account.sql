INSERT INTO relying_service.reference_accounts (account_id, action_reference)
VALUES ($1, $2)
ON CONFLICT (action_reference) DO NOTHING
