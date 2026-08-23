CREATE TABLE relying_service.claimant_outcome_proofs (
    proof_id TEXT PRIMARY KEY,
    expires_at_unix_seconds BIGINT NOT NULL
);

CREATE INDEX claimant_outcome_proofs_expiry
    ON relying_service.claimant_outcome_proofs (expires_at_unix_seconds);
