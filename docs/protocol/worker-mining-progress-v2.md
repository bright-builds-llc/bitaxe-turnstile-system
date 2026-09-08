# Worker mining progress filter observations

`worker-mining-progress-v2` retains the version-1 observations and adds three
required closed fields: `expected_filter`, `expected_filter_matches` and
`expected_filter_misses`. Historical version-1 records remain valid and do not
synthesize these counters.

The only filter identifier is `bm1366-ticket-256-leading-zero-40-v1`. It describes
a software expectation for the configured Ultra 205 ticket-256 model: the
unsigned SHA256d hash integer H must satisfy H < 2^216. Equivalently, bytes 27
through 31 of the raw little-endian digest must be zero. This combines the
software model's baseline 32-bit filter assumption with eight ticket-mask bits;
it is not a register-readback or silicon qualification claim.

Use this integer boundary, not a floating-point comparison with Bitcoin
difficulty 256. The excluded boundary H = 2^216 has Bitcoin difficulty
255.99609375, so the two predicates are not equivalent at the boundary.

Match and miss counts are canonical unsigned 64-bit decimal strings, reset for
a fresh Worker generation and retained through its terminal snapshot. They count
reconstructed matched candidates delivered to the existing scoreboard path,
including below-pool-target candidates. They do not assert a conservation rule
against parsed nonce counts or counters that reset on pool replacement.

The classifier reuses the already-computed hash. It changes no pool target,
qualification decision, submission, difficulty negotiation, lease, work gate,
or shutdown condition. It exposes no raw hash, header, nonce, job, pool
difficulty, credentials, endpoint or error text. The observation timestamp
remains capture time, and generation must match the containing qualification.

For a diagnostic allowance, initial-work collection stops promptly when the
first reconstructed candidate has either filter classification. It does not
wait for a pool-qualified or accepted share. Existing active-time limits and
shutdown reserves still stop the run when no candidate arrives. Empty counts
remain unverified filter evidence regardless of the generic Start-test result.
