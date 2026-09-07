export const progressFixture = {
  schema: "worker-mining-progress-v1", generation: 7, observed_at_ms: "18446744073709551615",
  poll_requested: "12", poll_idle: "3", poll_nonce: "7", poll_register: "2", stale_completion: "0",
  qualified_candidates: "0", below_pool_target: "7", duplicate_candidates: "0",
  discards: { invalid_length: "0", invalid_preamble: "0", invalid_crc: "0", job_lookup: "0", core: "0", address_interval: "0", register_response: "0", parser_invariant: "0" },
  blocked: { wrong_session: "0", job_lookup: "0", work_stale: "0", target_mismatch: "0", other: "0" },
};
