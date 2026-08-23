# Require idempotent Protected Action boundaries

Protected Actions implemented as local transactional writes update their state and outcome atomically. Any non-transactional external action must accept the Action Reference as an idempotency key so a worker crash after remote acceptance cannot duplicate the effect; integrations without that guarantee are ineligible to claim exactly-once Protected Action execution.
