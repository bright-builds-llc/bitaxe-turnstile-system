import { serialFailure } from "./worker-serial";
import type { NoiseJob } from "./worker-noise-diagnostic";

function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function retain(maybeBefore: unknown, maybeAfter: unknown): void {
  if (maybeBefore !== null && !same(maybeBefore, maybeAfter)) throw serialFailure("noise_retained_evidence");
}
/** One boot's retained job cannot change identity, rewrite progress or erase a failure. */
export class WorkerNoiseDiagnosticHistory {
  #maybePrevious: NoiseJob | undefined;
  observe(job: NoiseJob): void {
    const maybePrevious = this.#maybePrevious;
    if (maybePrevious) {
      for (const key of ["attemptId", "inputSha256", "bootOrdinal", "workerGeneration", "transportEpoch", "admittedAtUs", "authorityDeadlineUs"] as const) {
        if (maybePrevious[key] !== job[key]) throw serialFailure("noise_retained_identity");
      }
      retain(maybePrevious.localSocketPort, job.localSocketPort);
      retain(maybePrevious.firstFailure, job.firstFailure);
      retain(maybePrevious.terminal, job.terminal);
      if (job.stages.length < maybePrevious.stages.length) throw serialFailure("noise_retained_stages");
      for (const [index, stage] of maybePrevious.stages.entries()) if (!same(stage, job.stages[index])) throw serialFailure("noise_retained_stages");
      if ((maybePrevious.terminal || maybePrevious.firstFailure) && job.stages.slice(maybePrevious.stages.length).some(stage => !["socket_closed", "worker_quiescent"].includes(stage.stage))) throw serialFailure("noise_terminal_progress");
      const before = maybePrevious.resources, after = job.resources;
      if (maybePrevious.terminal && ((before.socketState === "not_created" && after.socketState !== "not_created") || (before.workerState === "not_started" && after.workerState !== "not_started"))) throw serialFailure("noise_terminal_owner_creation");
      for (const key of ["startedAtUs", "deadlineAtUs", "releasedAtUs", "deadlineMet", "failure"] as const) retain(before[key], after[key]);
      if (before.volatileInputsDisposed && !after.volatileInputsDisposed) throw serialFailure("noise_resource_regression");
      if (["not_created", "open", "closed"].indexOf(after.socketState) < ["not_created", "open", "closed"].indexOf(before.socketState) || ["not_started", "running", "quiescent"].indexOf(after.workerState) < ["not_started", "running", "quiescent"].indexOf(before.workerState)) throw serialFailure("noise_resource_regression");
    }
    this.#maybePrevious = structuredClone(job);
  }
}
