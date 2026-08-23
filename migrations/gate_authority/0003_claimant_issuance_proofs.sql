CREATE TABLE gate_authority.claimant_issuance_proofs (
    proof_id TEXT PRIMARY KEY,
    challenge_id TEXT NOT NULL REFERENCES gate_authority.work_challenges(challenge_id),
    expires_at_unix_seconds BIGINT NOT NULL
);

CREATE INDEX claimant_issuance_proofs_expiry
    ON gate_authority.claimant_issuance_proofs (expires_at_unix_seconds);
