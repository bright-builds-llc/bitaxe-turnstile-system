import type { WorkerMiningInterruption } from "./worker-mining-interruption";

/** One-use loss phase is armed before signing; resumed diagnostics keep their normal stop. */
export class WorkerRecoveryLoss {
  #maybePhase: "loss" | "resume" | undefined;
  #consumed = false;
  #sealed = false;
  configure(maybePhase: unknown): void {
    if (maybePhase === undefined) {
      if (this.#maybePhase !== undefined) throw new Error("recovery_phase_downgrade");
      return;
    }
    if (maybePhase !== "loss" && maybePhase !== "resume") throw new Error("recovery_phase_invalid");
    if (maybePhase === "loss" && (this.#consumed || this.#maybePhase === "resume")) throw new Error("recovery_loss_already_consumed");
    if (maybePhase === "resume" && this.#maybePhase === "loss" && !this.#sealed) throw new Error("recovery_loss_unsealed");
    this.#maybePhase = maybePhase;
  }
  get armed(): boolean { return this.#maybePhase === "loss" && !this.#consumed; }
  get sealed(): boolean { return this.#sealed; }
  seal(): void {
    if (this.#maybePhase !== "loss" || !this.#consumed) throw new Error("recovery_loss_not_consumed");
    this.#sealed = true;
  }
  async cut(operations: {
    prepareBoundary(): void; cleanupAfterFailure(): Promise<void>;
    snapshot(): unknown; flush(): Promise<void>; disconnect(): Promise<WorkerMiningInterruption>;
    publishClosed(): void; submit(body: { receipt: WorkerMiningInterruption; before: unknown; after: unknown }): Promise<unknown>;
  }): Promise<void> {
    if (!this.armed) throw new Error("recovery_loss_not_armed");
    this.#consumed = true;
    try {
      operations.prepareBoundary();
      const before = structuredClone(operations.snapshot());
      await operations.flush();
      const receipt = await operations.disconnect();
      operations.publishClosed();
      const after = structuredClone(operations.snapshot());
      await operations.flush();
      const result = await operations.submit({ receipt, before, after });
      if (!result || typeof result !== "object" || Object.keys(result).length !== 1 || !("recovery_loss_saved" in result) || result.recovery_loss_saved !== true) throw new Error("recovery_loss_receipt");
    } catch (error) {
      try { await operations.cleanupAfterFailure(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "Recovery loss cleanup failed"); }
      throw error;
    }
  }
}

export async function flushRecoverySupervisor(): Promise<void> {
  const maybeSupervisor = (globalThis as typeof globalThis & { recoverySupervisor?: { flush(): Promise<void> } }).recoverySupervisor;
  if (!maybeSupervisor) throw new Error("recovery_supervisor_missing");
  await maybeSupervisor.flush();
}
