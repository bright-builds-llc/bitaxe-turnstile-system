import type { WorkerTelemetryEndpoint } from "./worker-telemetry-cadence";
import type { WebSerialWorkerController } from "./worker-serial-controller.types";

export type WorkerStationEndpoint = WorkerTelemetryEndpoint & { controlSessionBindingSha256: string };

/**
 * One fresh possession-bound station endpoint for a task supervisor's HTTP
 * work. The private result returns directly to the caller and never enters
 * public page state; the operation grants no lease, work or liveness.
 */
export function createWorkerEndpointPageOperations(operations: {
  enabled(): boolean; idle(): boolean;
  maybeController(): Pick<WebSerialWorkerController, "prepareWorkerLeaseAuthorizationContext" | "telemetryCadenceEndpoint"> | undefined;
  invalidateAuthorization(): void;
}) {
  let consumed = false;
  return {
    async observeStationEndpoint(): Promise<WorkerStationEndpoint> {
      const maybeController = operations.maybeController();
      if (consumed || !operations.enabled() || !operations.idle() || !maybeController) throw new Error("station_endpoint_admission");
      consumed = true;
      operations.invalidateAuthorization();
      try {
        const context = await maybeController.prepareWorkerLeaseAuthorizationContext("start");
        const endpoint = await maybeController.telemetryCadenceEndpoint(context.controlSessionBindingSha256);
        if (endpoint.controlSessionBindingSha256 !== context.controlSessionBindingSha256) throw new Error("station_endpoint_binding");
        return endpoint;
      } finally {
        operations.invalidateAuthorization();
      }
    },
  };
}
