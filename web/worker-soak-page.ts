import type { WebSerialWorkerController } from "./worker-serial-controller.types";
import type { WorkerSoakLedger } from "./worker-soak-allowance";

/** Closed soak completion receipt from the local soak supervisor (firmware ADR-0033). */
export type WorkerSoakCompletion = { result: "passed" | "unverified"; ordinal: number; cumulative_charged_ms: number; cleanup_confirmed: true };

/**
 * Soak completion after the window: a fresh possession-bound soak ledger review, then closure, then the
 * local judgement. The soak never reads the qualification ledger or the immutable legacy campaign.
 */
export function createWorkerSoakPageOperations(operations: {
  enabled(): boolean;
  released(): boolean;
  controller(): Pick<WebSerialWorkerController, "prepareWorkerLeaseAuthorizationContext" | "soakAllowanceReview">;
  invalidateAuthorization(): void;
  close(): Promise<unknown>;
  flush(): Promise<unknown>;
  local(path: string, body: object): Promise<unknown>;
  state(): unknown;
}) {
  return {
    async submitSoakCompletion(): Promise<WorkerSoakCompletion> {
      operations.invalidateAuthorization();
      if (!operations.enabled() || !operations.released()) throw new Error("soak_completion_admission");
      const input = await operations.local("/completion-context", {});
      if (!input || typeof input !== "object" || Object.keys(input).length !== 1 || !("nonce" in input) || typeof input.nonce !== "string") throw new Error("soak_completion_context");
      await operations.controller().prepareWorkerLeaseAuthorizationContext("start");
      const ledger_after: WorkerSoakLedger = await operations.controller().soakAllowanceReview();
      await operations.close();
      await operations.flush();
      const receipt = await operations.local("/completion-review", { nonce: input.nonce, ledger_after, final_state: operations.state() });
      if (!receipt || typeof receipt !== "object" || !("result" in receipt) || !["passed", "unverified"].includes(String(receipt.result)) ||
        !("ordinal" in receipt) || !Number.isSafeInteger(receipt.ordinal) || Number(receipt.ordinal) < 1 ||
        !("cumulative_charged_ms" in receipt) || !Number.isSafeInteger(receipt.cumulative_charged_ms) || !("cleanup_confirmed" in receipt) || receipt.cleanup_confirmed !== true)
        throw new Error("soak_completion_receipt");
      return { result: receipt.result as "passed" | "unverified", ordinal: Number(receipt.ordinal), cumulative_charged_ms: Number(receipt.cumulative_charged_ms), cleanup_confirmed: true };
    },
  };
}
