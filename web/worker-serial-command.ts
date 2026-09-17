import { parseWorkerControlResult } from "./worker-control-rejection";
import { WORKER_CONTROLLER_PROTOCOL_VERSION } from "./worker-controller";
import type { WorkerSerialQualificationHook } from "./worker-serial-controller.types";
/** Controller response decoding keeps private command payloads out of diagnostic callbacks. */
export async function requestWorkerSerialCommand(input: {
  command: string; maybePayload: unknown; requestId: string; fenced: boolean;
  maybeHook: WorkerSerialQualificationHook | undefined;
  exchange(request: { requestId: string } & Record<string, unknown>, timeoutMs: number): Promise<unknown>;
}): Promise<unknown> {
  const { command, maybePayload, maybeHook } = input;
  if (["start_lease", "renew_lease", "pause", "cancel", "restore", "noise_diagnostic_start", "noise_diagnostic_cancel", "stratum_v2_channel_start", "stratum_v2_channel_cancel"].includes(command)) maybeHook?.observeStatus?.(undefined);
  const response = await input.exchange({ protocolVersion: WORKER_CONTROLLER_PROTOCOL_VERSION, requestId: input.requestId, command, ...(maybePayload === undefined ? {} : { payload: maybePayload }) }, ["restore", "pause", "cancel", "qualification_cooling"].includes(command) ? 145000 : 30000);
  return parseWorkerControlResult(response, error => {
    if (error === "restoration_pending" && input.fenced) maybeHook?.observeStatus?.(undefined);
    maybeHook?.maybeObserveDiagnostic?.({ category: "control_failure", authoritative: false, error });
  });
}
