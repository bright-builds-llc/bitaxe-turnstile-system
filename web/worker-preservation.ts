import { encodeBase64Url } from "./crypto-bytes";
import { exactSerialRecord, serialFailure } from "./worker-serial";

type WorkerPreservationDigests = {
  settings_sha256: string;
  authorization_high_water_sha256: string;
  device_identity_sha256: string;
  mine_on_boot: boolean;
};
/** Private wire observations. Never publish these stable digests in UI, records, or backend calls. */
export type WorkerPreservationV1 = { schema: "worker-preservation-v1" } & WorkerPreservationDigests;
/**
 * Version 2 adds only a device-local comparison of the stored pool configuration against its boot snapshot;
 * no pool value or pool digest leaves the device.
 */
export type WorkerPreservationV2 = { schema: "worker-preservation-v2"; pool_configuration_unchanged_since_boot: boolean } & WorkerPreservationDigests;
export type WorkerPreservation = WorkerPreservationV1 | WorkerPreservationV2;
/** Public comparison result tied to one unpredictable, page-local baseline. */
export type WorkerPreservationContinuity = {
  schema: "worker-preservation-continuity-v1";
  baseline_id: string;
  settings_match: boolean;
  authorization_high_water_match: boolean;
  device_identity_match: boolean;
  mine_on_boot: boolean;
};
const V1_FIELDS = ["schema", "settings_sha256", "authorization_high_water_sha256", "device_identity_sha256", "mine_on_boot"] as const;
/** Exact field set per version; every status-preservation path in every mode parses through here. */
export function parseWorkerPreservation(input: unknown): WorkerPreservation {
  const v2 = input !== null && typeof input === "object" && "schema" in input && input.schema === "worker-preservation-v2";
  const value = exactSerialRecord(input, v2 ? [...V1_FIELDS, "pool_configuration_unchanged_since_boot"] : V1_FIELDS);
  if (
    (value.schema !== "worker-preservation-v1" && !v2) ||
    typeof value.mine_on_boot !== "boolean" ||
    (v2 && typeof value.pool_configuration_unchanged_since_boot !== "boolean")
  )
    throw serialFailure("preservation_schema");
  for (const key of [
    "settings_sha256",
    "authorization_high_water_sha256",
    "device_identity_sha256",
  ] as const) {
    if (typeof value[key] !== "string" || !/^[0-9a-f]{64}$/u.test(value[key]))
      throw serialFailure("preservation_digest");
  }
  const digests: WorkerPreservationDigests = {
    settings_sha256: String(value.settings_sha256),
    authorization_high_water_sha256: String(
      value.authorization_high_water_sha256,
    ),
    device_identity_sha256: String(value.device_identity_sha256),
    mine_on_boot: value.mine_on_boot,
  };
  if (v2) return { schema: "worker-preservation-v2", ...digests, pool_configuration_unchanged_since_boot: value.pool_configuration_unchanged_since_boot === true };
  return { schema: "worker-preservation-v1", ...digests };
}
/** Retains only a page-local first snapshot; comparisons never reset it after a mismatch. */
export class WorkerPreservationBaseline {
  #maybeBaseline: WorkerPreservation | undefined;
  #maybeBaselineId: string | undefined;
  #maybePublic: WorkerPreservationContinuity | undefined;
  observe(input: WorkerPreservation): void {
    const current = parseWorkerPreservation(input);
    if (!this.#maybeBaseline) {
      this.#maybeBaseline = current;
      this.#maybeBaselineId = encodeBase64Url(
        crypto.getRandomValues(new Uint8Array(16)),
      );
    }
    const baseline = this.#maybeBaseline;
    const baselineId = this.#maybeBaselineId;
    if (!baselineId) throw serialFailure("preservation_baseline");
    this.#maybePublic = {
      schema: "worker-preservation-continuity-v1",
      baseline_id: baselineId,
      settings_match: current.settings_sha256 === baseline.settings_sha256,
      authorization_high_water_match:
        current.authorization_high_water_sha256 ===
        baseline.authorization_high_water_sha256,
      device_identity_match:
        current.device_identity_sha256 === baseline.device_identity_sha256,
      mine_on_boot: current.mine_on_boot,
    };
  }
  maybePublicState(): WorkerPreservationContinuity | undefined {
    return this.#maybePublic ? { ...this.#maybePublic } : undefined;
  }
}
