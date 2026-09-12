import type { WebSerialWorkerController } from "./webserial-worker-controller";

/** Restore consumes possession; explicit idle trace reviews always obtain fresh proof. */
export async function reviewDeviceSerialTrace(controller: Pick<WebSerialWorkerController, "prepareWorkerLeaseAuthorizationContext" | "deviceSerialTraceReview">) {
  await controller.prepareWorkerLeaseAuthorizationContext("start");
  return controller.deviceSerialTraceReview();
}
