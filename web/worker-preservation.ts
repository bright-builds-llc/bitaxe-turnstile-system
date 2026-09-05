import { encodeBase64Url } from "./crypto-bytes";
import { exactSerialRecord, serialFailure } from "./worker-serial";

/** Private wire observations. Never publish these stable digests in UI, records, or backend calls. */
export type WorkerPreservation = {
  schema: "worker-preservation-v1";
  settings_sha256: string;
  authorization_high_water_sha256: string;
  device_identity_sha256: string;
  mine_on_boot: boolean;
};
/** Public comparison result tied to one unpredictable, page-local baseline. */
export type WorkerPreservationContinuity = {
  schema: "worker-preservation-continuity-v1";
  baseline_id: string;
  settings_match: boolean;
  authorization_high_water_match: boolean;
  device_identity_match: boolean;
  mine_on_boot: boolean;
};
export function parseWorkerPreservation(input: unknown): WorkerPreservation {
  const value = exactSerialRecord(input, [
    "schema",
    "settings_sha256",
    "authorization_high_water_sha256",
    "device_identity_sha256",
    "mine_on_boot",
  ]);
  if (
    value.schema !== "worker-preservation-v1" ||
    typeof value.mine_on_boot !== "boolean"
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
  return {
    schema: "worker-preservation-v1",
    settings_sha256: String(value.settings_sha256),
    authorization_high_water_sha256: String(
      value.authorization_high_water_sha256,
    ),
    device_identity_sha256: String(value.device_identity_sha256),
    mine_on_boot: value.mine_on_boot,
  };
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
