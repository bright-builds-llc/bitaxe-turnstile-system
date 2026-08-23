UPDATE gate_authority.authority_outbox
SET status = 'completed'
WHERE aggregate_id = $1 AND kind = 'gate_pass_signing'
