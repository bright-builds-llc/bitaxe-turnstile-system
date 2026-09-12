import type { WorkerControllerStatus } from "./worker-controller";
import { workerDeviceBaselineConfirmed } from "./worker-device-baseline";
import { serialFailure } from "./worker-serial";
import { workerSerialFailureCategory } from "./worker-serial-errors";
import type { BrowserTraceBoundary } from "./worker-browser-serial-trace";

export type WorkerReadInterruption = {
  schema: "worker-read-interruption-v2";
  request_consumed: true;
  host_observation: BrowserTraceBoundary;
} & ({ interrupted: true; response_promise_pending: true; ownership_released: true } |
  { interrupted: false; response_promise_pending: false; ownership_released: false });

/** Holds one no-mining read operation; only consumed, still-pending responses permit interruption. */
export class WorkerReadInterruptionOwner {
  #active = false;
  get active(): boolean { return this.#active; }
  async run(operations: {
    admitted: boolean;
    check(): void;
    baseline(): Promise<WorkerControllerStatus>;
    request(afterConsumed: (pending: boolean) => Promise<void>): Promise<unknown>;
    close(): Promise<void>;
    released(): boolean;
    observation(): BrowserTraceBoundary;
  }): Promise<WorkerReadInterruption> {
    if (this.#active) throw serialFailure("operation_active");
    if (!operations.admitted) throw serialFailure("probe_admission");
    this.#active = true;
    let interrupted = false, closed = false;
    let maybeObservation: BrowserTraceBoundary | undefined;
    try {
      operations.check();
      const baseline = await operations.baseline();
      operations.check();
      if (!workerDeviceBaselineConfirmed(baseline) || baseline.lease !== undefined)
        throw serialFailure("probe_admission");
      try {
        await operations.request(async pending => {
          operations.check();
          maybeObservation = operations.observation();
          if (!pending) return;
          interrupted = true;
          await operations.close();
          closed = true;
        });
      } catch (error) {
        if (!interrupted || !closed || workerSerialFailureCategory(error) !== "closed") throw error;
      }
      if (!maybeObservation) throw serialFailure("probe_admission");
      if (!interrupted) return { schema: "worker-read-interruption-v2", interrupted: false,
        request_consumed: true, response_promise_pending: false, ownership_released: false, host_observation: maybeObservation };
      if (!closed || !operations.released()) throw serialFailure("cleanup_pending");
      return { schema: "worker-read-interruption-v2", interrupted: true,
        request_consumed: true, response_promise_pending: true, ownership_released: true, host_observation: maybeObservation };
    } finally {
      this.#active = false;
    }
  }
}
