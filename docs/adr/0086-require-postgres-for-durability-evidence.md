# Require PostgreSQL for durability evidence

Runnable Gate Authority and Relying Service deployments, integration tests, and acceptance tests use PostgreSQL as their authoritative store. In-memory adapters remain useful only for narrow domain-unit tests and cannot satisfy persistence, restart, concurrency, response-loss, or recovery acceptance criteria.
