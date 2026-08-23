INSERT INTO gate_authority.share_fingerprints (share_fingerprint, challenge_id)
VALUES ($1, $2)
ON CONFLICT (share_fingerprint) DO NOTHING
