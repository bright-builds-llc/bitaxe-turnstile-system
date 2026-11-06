-- The raw Pool-facing payout choice lives only here, and only until its challenge ends.
CREATE TABLE pool_adapter.session_pool_selections (
    session_id TEXT PRIMARY KEY CHECK (session_id ~ '^session_[A-Za-z0-9_-]{1,128}$'),
    challenge_id TEXT NOT NULL UNIQUE CHECK (challenge_id ~ '^challenge_[A-Za-z0-9]{1,128}$'),
    pool_offer_id TEXT NOT NULL CHECK (pool_offer_id ~ '^[A-Za-z0-9_-]{1,128}$'),
    payout_destination_type TEXT NOT NULL CHECK (
        payout_destination_type IN ('bitcoin_mainnet_address', 'approved_beneficiary')
    ),
    payout_destination TEXT NOT NULL CHECK (LENGTH(payout_destination) BETWEEN 1 AND 256),
    payout_commitment TEXT NOT NULL CHECK (payout_commitment ~ '^[0-9a-f]{64}$'),
    challenge_expires_at_unix_seconds BIGINT NOT NULL CHECK (
        challenge_expires_at_unix_seconds > 0
    ),
    recorded_at_unix_seconds BIGINT NOT NULL CHECK (recorded_at_unix_seconds > 0)
);

CREATE INDEX session_pool_selections_expiry
    ON pool_adapter.session_pool_selections (challenge_expires_at_unix_seconds);
