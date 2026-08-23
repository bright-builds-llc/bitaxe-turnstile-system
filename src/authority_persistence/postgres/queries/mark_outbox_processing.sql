UPDATE gate_authority.authority_outbox
SET status = 'processing'
WHERE aggregate_id = $1 AND kind = 'gate_pass_signing'
