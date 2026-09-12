import type { WorkerControllerStatus } from "./worker-controller";
import { diagnosticInitialWorkCaptured } from "./worker-diagnostic-work";
import { serialFailure } from "./worker-serial";

export type WorkerMiningInterruption = { schema: "worker-mining-interruption-v1"; generation: number; workDispatched: number; workGateRemainingMs: number; ownershipReleased: true; controlRecordsSent: 0 };

/** Retains only parsed diagnostic work observations; no caller-supplied work evidence. */
export class WorkerMiningInterruptionOwner {
  #maybeObservation: { observedAt: number; generation: number; workDispatched: number; workGateRemainingMs: number } | undefined;
  clear(): void { this.#maybeObservation = undefined; }
  observe(status: WorkerControllerStatus, now: number): void {
    this.clear();
    const maybeQualification = status.qualification;
    if (status.state !== "mining" || maybeQualification?.attempt?.purpose !== "diagnostic" || maybeQualification.attempt.complete || maybeQualification.revocation_reason !== "none" || !diagnosticInitialWorkCaptured(maybeQualification) || maybeQualification.work_gate_remaining_ms === null) return;
    this.#maybeObservation = { observedAt: now, generation: maybeQualification.generation, workDispatched: maybeQualification.work_dispatched, workGateRemainingMs: maybeQualification.work_gate_remaining_ms };
  }
  async interrupt(now: number, admitted: boolean, closeWithoutWire: () => Promise<void>, released: () => boolean): Promise<WorkerMiningInterruption> {
    const observation = this.#maybeObservation;
    if (!admitted || !observation || now < observation.observedAt || now - observation.observedAt > 1000 || observation.workGateRemainingMs - (now - observation.observedAt) <= 3000) throw serialFailure("probe_admission");
    this.clear();
    await closeWithoutWire();
    if (!released()) throw serialFailure("cleanup_pending");
    return { schema: "worker-mining-interruption-v1", generation: observation.generation, workDispatched: observation.workDispatched, workGateRemainingMs: observation.workGateRemainingMs, ownershipReleased: true, controlRecordsSent: 0 };
  }
}
