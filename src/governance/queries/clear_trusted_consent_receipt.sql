UPDATE trusted_consent_ceremonies
SET trusted_consent_receipt = NULL,
    receipt_issued_at_unix_seconds = NULL,
    receipt_expires_at_unix_seconds = NULL
WHERE ceremony_id = $1
  AND status = 'verified'
  AND trusted_consent_receipt IS NOT NULL
  AND receipt_expires_at_unix_seconds = $2
  AND receipt_expires_at_unix_seconds <= $3
