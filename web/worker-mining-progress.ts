import { exactSerialRecord, serialFailure } from "./worker-serial";
const counts = ["poll_requested", "poll_idle", "poll_nonce", "poll_register", "stale_completion", "qualified_candidates", "below_pool_target", "duplicate_candidates"] as const;
const discards = ["invalid_length", "invalid_preamble", "invalid_crc", "job_lookup", "core", "address_interval", "register_response", "parser_invariant"] as const;
const blocked = ["wrong_session", "job_lookup", "work_stale", "target_mismatch", "other"] as const;
type Counts<Keys extends readonly string[]> = { [Key in Keys[number]]: string };
/** Observations only. Counts do not establish ASIC work, pool acceptance, or lease authority. */
export type WorkerMiningProgress = Counts<typeof counts> & {
  schema: "worker-mining-progress-v1";
  generation: number;
  observed_at_ms: string;
  discards: Counts<typeof discards>;
  blocked: Counts<typeof blocked>;
};
function decimal(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/u.test(value)
      || BigInt(value) > 18446744073709551615n) throw serialFailure("fields");
  return value;
}
function parseCounts<Keys extends readonly string[]>(input: unknown, keys: Keys): Counts<Keys> {
  const value = exactSerialRecord(input, [...keys]);
  return Object.fromEntries(keys.map((key) => [key, decimal(value[key])])) as Counts<Keys>;
}
/** Strict optional extension; absent historical data stays absent, never synthesized as zero. */
export function parseWorkerMiningProgress(input: unknown, generation: number): WorkerMiningProgress {
  const value = exactSerialRecord(input, ["schema", "generation", "observed_at_ms", ...counts, "discards", "blocked"]);
  if (value.schema !== "worker-mining-progress-v1" || value.generation !== generation
      || !Number.isInteger(generation) || generation <= 0 || generation > 0xffffffff) throw serialFailure("fields");
  const projectedCounts = Object.fromEntries(counts.map((key) => [key, decimal(value[key])])) as Counts<typeof counts>;
  return { schema: "worker-mining-progress-v1", generation, observed_at_ms: decimal(value.observed_at_ms),
    ...projectedCounts, discards: parseCounts(value.discards, discards), blocked: parseCounts(value.blocked, blocked) };
}
