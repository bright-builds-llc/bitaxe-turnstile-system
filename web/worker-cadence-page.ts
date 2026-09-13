import { runWorkerCadenceUsbPhase, type WorkerCadenceAcceptance } from "./worker-cadence-acceptance";
import type { WorkerCadencePhase } from "./worker-telemetry-cadence";
import type { WebSerialWorkerController } from "./webserial-worker-controller";

/** The endpoint result is private: these operations never publish or retain it. */
export function createWorkerCadencePageOperations(operations: {
  cadence: WorkerCadenceAcceptance; controller(): Pick<WebSerialWorkerController, "telemetryCadenceArm" | "telemetryCadenceReview" | "telemetryCadenceEndpoint" | "transportProbe">;
  running(): boolean; loaded(): boolean; maybeReviewedBinding(): string | undefined; invalidateAuthorization(): void; publish(): void;
  local(path: string, body: object): Promise<unknown>;
}) {
  const idle = () => {
    operations.cadence.requireIdle(operations.running(), operations.loaded());
    operations.invalidateAuthorization();
  };
  return {
    async cadenceArm(phase: WorkerCadencePhase) {
      idle();
      const receipt = await operations.controller().telemetryCadenceArm(phase);
      operations.cadence.arm(receipt);
      operations.publish();
      return receipt;
    },
    async cadenceReview() {
      idle();
      const review = await operations.controller().telemetryCadenceReview();
      operations.cadence.review(review);
      operations.publish();
      return review;
    },
    async cadenceEndpoint() {
      const maybeBinding = operations.maybeReviewedBinding(); idle();
      if (!maybeBinding) throw new Error("cadence_endpoint_possession_required");
      return operations.controller().telemetryCadenceEndpoint(maybeBinding);
    },
    async cadenceUsbPhase() {
      idle();
      return runWorkerCadenceUsbPhase({
        probe: () => operations.controller().transportProbe(), now: () => performance.now(),
        wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
        record: async receipt => {
          const result = await operations.local("/cadence/probe", receipt);
          if (!result || typeof result !== "object" || Object.keys(result).length !== 1 || !("cadence_probe_saved" in result) || result.cadence_probe_saved !== true) throw new Error("cadence_probe_receipt");
        },
      });
    },
  };
}
