import type { WorkerControllerStatus, WorkerLeaseGrant } from "./worker-controller";
import type { WorkerCadenceArm, WorkerCadenceReview } from "./worker-telemetry-cadence";

/** A dedicated, sticky mode; observations never grant work or relax signed bounds. */
export class WorkerCadenceAcceptance {
  #enabled = false;
  #maybeMiningArm: WorkerCadenceArm | undefined;
  #maybeFirstWork: number | undefined;
  #maybeLatestWork: { atMs: number; generation: number; workDispatched: number } | undefined;
  #suppressionRequested = false;
  #maybeReview: WorkerCadenceReview | undefined;
  configure(maybeEnabled: true | undefined): void {
    if (this.#enabled && maybeEnabled !== true) throw new Error("cadence_mode_downgrade");
    this.#enabled = maybeEnabled === true;
  }
  get enabled(): boolean { return this.#enabled; }
  requireIdle(running: boolean, loaded: boolean): void {
    if (!this.#enabled || running || loaded) throw new Error("cadence_admission");
  }
  arm(receipt: WorkerCadenceArm): void {
    if (!this.#enabled) throw new Error("cadence_admission");
    if (receipt.phase !== "mining") return;
    if (this.#maybeMiningArm) throw new Error("cadence_mining_consumed");
    this.#maybeMiningArm = receipt;
  }
  review(value: WorkerCadenceReview): void { this.#maybeReview = structuredClone(value); }
  requireWindow(grant: WorkerLeaseGrant): void {
    if (!this.#enabled) return;
    if (!this.#maybeMiningArm || this.#suppressionRequested || grant.acceptanceCampaign || grant.qualificationAttempt?.purpose !== "normal" || grant.qualificationAttempt.maximumActiveMilliseconds !== 180000) throw new Error("cadence_window_required");
  }
  observe(maybeStatus: WorkerControllerStatus | undefined, now: number): void {
    now = Math.floor(now);
    if (!this.#maybeMiningArm || this.#suppressionRequested) return;
    if (!maybeStatus) { this.#maybeLatestWork = undefined; return; }
    const value = maybeStatus.qualification;
    if (maybeStatus.state !== "mining" || value?.attempt?.purpose !== "normal" || value.attempt.complete || value.revocation_reason !== "none" || value.work_dispatched < 1) {
      this.#maybeLatestWork = undefined;
      if (this.#maybeFirstWork !== undefined) throw new Error("cadence_work_lost");
      return;
    }
    if (value.generation !== this.#maybeMiningArm.generation) throw new Error("cadence_generation_mismatch");
    if (!Number.isFinite(now) || now < 0 || (this.#maybeLatestWork && (now < this.#maybeLatestWork.atMs || value.work_dispatched < this.#maybeLatestWork.workDispatched))) throw new Error("cadence_observation_invalid");
    this.#maybeFirstWork ??= now;
    this.#maybeLatestWork = { atMs: now, generation: value.generation, workDispatched: value.work_dispatched };
  }
  shouldSuppress(now: number): boolean {
    now = Math.floor(now);
    return this.#enabled && !this.#suppressionRequested && this.#maybeFirstWork !== undefined && now - this.#maybeFirstWork >= 62000;
  }
  suppress(now: number, capturePreservation: () => void): void {
    now = Math.floor(now);
    if (!this.shouldSuppress(now) || !this.#maybeLatestWork || now < this.#maybeLatestWork.atMs || now - this.#maybeLatestWork.atMs > 1500) throw new Error("cadence_suppression_admission");
    capturePreservation();
    this.#suppressionRequested = true;
  }
  state() {
    return { schema: "worker-cadence-browser-v1" as const, enabled: this.#enabled, suppressionRequested: this.#suppressionRequested,
      ...(this.#maybeFirstWork === undefined ? {} : { firstWorkObservedAtMs: this.#maybeFirstWork }),
      ...(this.#maybeLatestWork ? { latestWork: { ...this.#maybeLatestWork } } : {}),
      ...(this.#maybeReview ? { review: structuredClone(this.#maybeReview) } : {}) };
  }
}

export type WorkerCadenceProbeReceipt = { ordinal: number; scheduledAtMs: number; startedAtMs: number; completedAtMs: number; requestPayloadBytes: 65536; responsePayloadBytes: 65536 };
/** One awaited request at a time; an overrun aborts instead of compressing the schedule. */
export async function runWorkerCadenceUsbPhase(operations: {
  probe(): Promise<{ requestPayloadBytes: number; responsePayloadBytes: number }>;
  now(): number; wait(milliseconds: number): Promise<void>;
  record(receipt: WorkerCadenceProbeReceipt): Promise<void>;
}): Promise<{ schema: "worker-cadence-usb-v1"; probes: WorkerCadenceProbeReceipt[] }> {
  const now = () => {
    const observed = operations.now();
    if (!Number.isFinite(observed) || observed < 0) throw new Error("cadence_probe_clock");
    return Math.floor(observed);
  };
  const began = now();
  const probes: WorkerCadenceProbeReceipt[] = [];
  for (let index = 0; index < 12; index += 1) {
    const scheduledAtMs = began + index * 5000;
    const before = now();
    if (before < began || before > scheduledAtMs + 1000) throw new Error("cadence_probe_schedule");
    if (before < scheduledAtMs) await operations.wait(scheduledAtMs - before);
    const startedAtMs = now();
    if (startedAtMs < scheduledAtMs || startedAtMs > scheduledAtMs + 1000) throw new Error("cadence_probe_schedule");
    const result = await operations.probe();
    const completedAtMs = now();
    if (result.requestPayloadBytes !== 65536 || result.responsePayloadBytes !== 65536 || completedAtMs < startedAtMs || completedAtMs >= scheduledAtMs + 5000) throw new Error("cadence_probe_incomplete");
    const receipt: WorkerCadenceProbeReceipt = { ordinal: index + 1, scheduledAtMs, startedAtMs, completedAtMs, requestPayloadBytes: 65536, responsePayloadBytes: 65536 };
    probes.push(receipt);
    await operations.record(receipt);
  }
  return { schema: "worker-cadence-usb-v1", probes };
}
