# Build the Gate Authority as a modular Rust monolith

V1 will deploy one modular Rust Gate Authority owning public APIs, challenge lifecycle, PostgreSQL work ledger, Gate Pass signing, SSE progress, Action Policy administration, discovery, expiry, outbox processing, and the operator backend. Domain ports keep effects independently testable, while the Pool Adapter and Worker Management remain separate processes because they have genuine network, licensing, security, and failure boundaries.
