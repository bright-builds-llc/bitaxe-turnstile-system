import { exactSerialRecord, serialFailure, serialFailureFor } from "./worker-serial";
import type { WorkerControllerStatus } from "./worker-controller";
export type QualificationCoolingAction = "prove_fan" | "restore_baseline";
export type WorkerCoolingProof = { schema: "worker-cooling-proof-v1"; fan_duty_percent: 100; fan_rpm: number; post_command_fan_proven: true; asic_effects: false; budget_reserved: false };
export type WorkerCoolingBaseline = { schema: "worker-cooling-baseline-v1"; fan_duty_percent: 30; cooling_proven: true; asic_effects: false; budget_reserved: false };
export function parseQualificationCoolingAction(value: unknown): QualificationCoolingAction {
  if (value !== "prove_fan" && value !== "restore_baseline") throw serialFailure("fields");
  return value;
}
export function parseQualificationCoolingResult(action: QualificationCoolingAction, input: unknown): WorkerCoolingProof | WorkerCoolingBaseline {
  const common = ["schema", "fan_duty_percent", "asic_effects", "budget_reserved"];
  const value = exactSerialRecord(input, [...common, ...(action === "prove_fan" ? ["fan_rpm", "post_command_fan_proven"] : ["cooling_proven"])]);
  if (value.asic_effects !== false || value.budget_reserved !== false) throw serialFailure("fields");
  if (action === "prove_fan") {
    if (value.schema !== "worker-cooling-proof-v1" || value.fan_duty_percent !== 100 || value.post_command_fan_proven !== true || typeof value.fan_rpm !== "number" || !Number.isInteger(value.fan_rpm) || value.fan_rpm < 1 || value.fan_rpm > 65535) throw serialFailure("fields");
    return { schema: "worker-cooling-proof-v1", fan_duty_percent: 100, fan_rpm: value.fan_rpm, post_command_fan_proven: true, asic_effects: false, budget_reserved: false };
  }
  if (value.schema !== "worker-cooling-baseline-v1" || value.fan_duty_percent !== 30 || value.cooling_proven !== true) throw serialFailure("fields");
  return { schema: "worker-cooling-baseline-v1", fan_duty_percent: 30, cooling_proven: true, asic_effects: false, budget_reserved: false };
}
/** Fan-only qualification changes no ASIC state and never reserves a mining window. */
export async function runQualificationCooling(actionInput: QualificationCoolingAction, operations: {
  prove(): Promise<unknown>;
  request(action: QualificationCoolingAction): Promise<unknown>;
  invalidate(possession: boolean): void;
  status(): Promise<WorkerControllerStatus>;
  failed(error: Error): void;
}) {
  const action = parseQualificationCoolingAction(actionInput);
  try {
  if (action === "prove_fan") await operations.prove();
  operations.invalidate(action === "restore_baseline");
  const result = parseQualificationCoolingResult(action, await operations.request(action));
  if (action === "restore_baseline") {
    const observed = await operations.status();
    if (observed.state !== "baseline" || observed.restoration.status !== "confirmed") throw serialFailure("restoration_unconfirmed");
  }
  return result;
  } catch (error) {
    const failure = serialFailureFor(error, "request_failed");
    operations.failed(failure);
    throw failure;
  }
}
