DELETE FROM dpop_proofs
WHERE proof_id = $1
  AND expires_at_unix_seconds = $2
  AND expires_at_unix_seconds < $3
