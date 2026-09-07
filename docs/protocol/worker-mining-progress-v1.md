# Worker mining progress observations

The optional `qualification.mining_progress` object uses schema
`worker-mining-progress-v1`. It is a closed, read-only snapshot from the firmware's
sole production owner. It never authorizes work, extends a lease, changes a
qualification budget, or introduces a new shutdown requirement.

`generation` matches the containing qualification generation. `observed_at_ms`
and all counters are canonical unsigned 64-bit decimal strings. The timestamp
is the actual snapshot capture time, including for retained terminal evidence;
reading it does not refresh the timestamp. Historical records may omit the object.

The top-level counters are `poll_requested`, `poll_idle`, `poll_nonce`,
`poll_register`, `stale_completion`, `qualified_candidates`, `below_pool_target`
and `duplicate_candidates`. `discards` contains `invalid_length`,
`invalid_preamble`, `invalid_crc`, `job_lookup`, `core`, `address_interval`,
`register_response` and `parser_invariant`. `blocked` contains `wrong_session`,
`job_lookup`, `work_stale`, `target_mismatch` and `other`. Unknown fields are rejected
at every object boundary.

ASIC bridge counters reset at preparation. Candidate classification counters are
from the currently projected pool runtime or its retained terminal view and may
reset when a pool runtime is replaced. These counters are not a cumulative mining
time or budget ledger and must not be combined into an assumed conservation rule.

`poll_nonce` counts parsed nonce completions; `qualified_candidates` counts
candidates that qualify for submission. Valid nonces below the pool target can
therefore coexist with zero qualified candidates and zero submissions. The legacy
`nonce_work_correlations` field retains its existing qualified-candidate-delta
meaning; it does not count every parsed or correlated nonce.

`poll_idle` is not proof of electrically silent UART: the existing adapter maps
some read errors and partial-read failures to pending results. CRC/preamble/job
and blocked-correlation counts distinguish further stages when present. No raw
UART bytes, jobs, pool difficulty, credentials, endpoints or error strings are
included.
