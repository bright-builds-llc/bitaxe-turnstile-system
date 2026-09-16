import { WorkerNoiseDiagnosticHistory } from "./worker-noise-diagnostic-history";
import type { NoiseStartInputV2, NoiseStatusV2 } from "./worker-noise-diagnostic";
import type { WebSerialWorkerController } from "./webserial-worker-controller";
import type { WorkerPreservationContinuity } from "./worker-preservation";

/** Same-page attempt memory survives normal serial reacquisition, never page replacement. */
export function createWorkerNoisePageOperations(operations: {
  changed(): void;
  phase(): "before" | "candidate" | undefined;
  idle(): boolean; controller(): Pick<WebSerialWorkerController, "prepareWorkerLeaseAuthorizationContext" | "noiseDiagnosticStart" | "noiseDiagnosticStatus" | "noiseDiagnosticCancel">;
  maybePreservation(): WorkerPreservationContinuity | undefined;
}) {
  let startConsumed = false;
  const history = new WorkerNoiseDiagnosticHistory();
  const requireCandidate = () => {
    if (operations.phase() !== "candidate" || !operations.idle()) throw new Error("noise_page_admission");
  };
  const requirePreservation = () => {
    const maybeBaseline = operations.maybePreservation();
    if (!maybeBaseline || !maybeBaseline.settings_match || !maybeBaseline.authorization_high_water_match || !maybeBaseline.device_identity_match || maybeBaseline.mine_on_boot) throw new Error("noise_preservation_required");
  };
  const observe = (status: NoiseStatusV2) => { if (status.job) history.observe(status.job); return status; };
  return {
    async noiseDiagnosticPossession() {
      requireCandidate();
      const result = await operations.controller().prepareWorkerLeaseAuthorizationContext("start");
      requireCandidate();
      return result.controlSessionBindingSha256;
    },
    async noiseDiagnosticStart(input: NoiseStartInputV2, expectedBinding: string) {
      requireCandidate(); requirePreservation();
      if (startConsumed) throw new Error("noise_page_start_consumed");
      startConsumed = true;
      try { return observe(await operations.controller().noiseDiagnosticStart(input, expectedBinding)); } finally { operations.changed(); }
    },
    async noiseDiagnosticStatus(attemptIdOrNull: string | null, expectedBinding: string) {
      requireCandidate();
      return observe(await operations.controller().noiseDiagnosticStatus(attemptIdOrNull, expectedBinding));
    },
    async noiseDiagnosticCancel(attemptId: string, expectedBinding: string) {
      requireCandidate();
      try { return observe(await operations.controller().noiseDiagnosticCancel(attemptId, expectedBinding)); } finally { operations.changed(); }
    },
  };
}
