ALTER TABLE gate_authority.pool_offer_replacements
ADD COLUMN required_signed_pool_offers JSONB,
ADD COLUMN disclosure_digest_sha256 TEXT,
ADD COLUMN required_signature_digest_sha256 TEXT,
ADD CONSTRAINT material_pool_offer_confirmation_shape CHECK (
    (required_signed_pool_offers IS NULL AND disclosure_digest_sha256 IS NULL
     AND required_signature_digest_sha256 IS NULL)
    OR
    (status = 'pending_reconfirmation' AND required_signed_pool_offers IS NOT NULL
     AND disclosure_digest_sha256 ~ '^[A-Za-z0-9_-]{43}$'
     AND required_signature_digest_sha256 ~ '^[A-Za-z0-9_-]{43}$')
);

ALTER TABLE gate_authority.work_sessions
ADD COLUMN material_trusted_confirmation_required BOOLEAN NOT NULL DEFAULT FALSE;
