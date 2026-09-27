import { parseQualificationRestartRequest, type WorkerQualificationRestartRequest } from "./worker-qualification-restart";
import type { WebSerialWorkerController } from "./worker-serial-controller.types";

/** Protected evidence returns directly to the task supervisor, never to public page state. */
export function createWorkerRestartPageOperations(operations: {
  enabled(): boolean; idle(): boolean;
  maybeController(): Pick<WebSerialWorkerController, "qualificationRestart" | "qualificationRestartEvidence"> | undefined;
  before(): void; succeeded(): void; failed(): void;
}) {
  return {
    async qualificationRestart(input: WorkerQualificationRestartRequest) {
      const maybeController = operations.maybeController();
      if (!operations.enabled() || !operations.idle() || !maybeController) throw new Error("restart_admission");
      const request = parseQualificationRestartRequest(input); operations.before();
      try { const result = await maybeController.qualificationRestart(request); operations.succeeded(); return result; }
      catch (error) { operations.failed(); throw error; }
    },
    exportRestartEvidence: () => operations.enabled() ? operations.maybeController()?.qualificationRestartEvidence() : undefined,
  };
}

/** Explicit diagnostic capability; the ordinary restart operation remains unchanged. */
export function createWorkerCoreDumpPageOperations(operations: {
  enabled(): boolean; idle(): boolean;
  maybeController(): Pick<WebSerialWorkerController, "coreDumpSelfTest" | "qualificationRestartEvidence"> | undefined;
  before(): void; succeeded(): void; failed(): void;
}) {
  let consumed = false;
  return {
    async coreDumpSelfTest(input: WorkerQualificationRestartRequest) {
      const maybeController = operations.maybeController();
      if (consumed || !operations.enabled() || !operations.idle() || !maybeController) throw new Error("core_dump_self_test_admission");
      const request = parseQualificationRestartRequest(input); consumed = true; operations.before();
      try { const result = await maybeController.coreDumpSelfTest(request); operations.succeeded(); return result; }
      catch (error) { operations.failed(); throw error; }
    },
    exportCoreDumpSelfTestEvidence: () => operations.enabled() ? operations.maybeController()?.qualificationRestartEvidence() : undefined,
  };
}
