import {
  WORKER_CONTROLLER_PROTOCOL_VERSION,
  type WorkerController,
  type WorkerControllerDisconnectReason,
} from "./worker-controller";
import {
  decodeWorkerControllerUsbEnvelope,
  decodeWorkerControllerUsbRequest,
  encodeWorkerControllerUsbMessage,
  type WorkerControllerUsbExchange,
  type WorkerControllerUsbResponse,
} from "./worker-controller-usb";

/** Simulator-backed USB exchange with an explicit device-local disconnect event. */
export class SimulatedWorkerControllerUsbExchange implements WorkerControllerUsbExchange {
  readonly #controller: WorkerController;
  readonly #disconnectListeners = new Set<
    (reason: WorkerControllerDisconnectReason) => Promise<void>
  >();

  constructor(controller: WorkerController) {
    this.#controller = controller;
  }

  async transact(frame: Uint8Array): Promise<Uint8Array> {
    let requestId = "usb_invalid";
    try {
      requestId = decodeWorkerControllerUsbEnvelope(frame).requestId;
      const request = decodeWorkerControllerUsbRequest(frame);
      const result = await dispatch(this.#controller, request);
      return encodeWorkerControllerUsbMessage({
        protocolVersion: WORKER_CONTROLLER_PROTOCOL_VERSION,
        requestId,
        ok: true,
        result,
      } satisfies WorkerControllerUsbResponse);
    } catch {
      return encodeWorkerControllerUsbMessage({
        protocolVersion: WORKER_CONTROLLER_PROTOCOL_VERSION,
        requestId,
        ok: false,
        error: { code: "command_rejected", message: "Worker Controller command was rejected" },
      } satisfies WorkerControllerUsbResponse);
    }
  }

  subscribeDisconnect(
    listener: (reason: WorkerControllerDisconnectReason) => Promise<void>,
  ): () => void {
    this.#disconnectListeners.add(listener);
    return () => this.#disconnectListeners.delete(listener);
  }

  async disconnect(): Promise<void> {
    await this.#controller.restore("connectivity_lost");
    await Promise.all([...this.#disconnectListeners].map((listener) => listener("connectivity_lost")));
  }
}

/** Creates one simulator-backed exchange suitable for UsbWorkerController conformance. */
export function simulatedWorkerControllerUsbExchange(
  controller: WorkerController,
): SimulatedWorkerControllerUsbExchange {
  return new SimulatedWorkerControllerUsbExchange(controller);
}

async function dispatch(
  controller: WorkerController,
  request: ReturnType<typeof decodeWorkerControllerUsbRequest>,
) {
  switch (request.command) {
    case "discover":
      return controller.discover();
    case "status":
      return controller.status();
    case "pause":
      return controller.pause();
    case "cancel":
      return controller.cancel();
    case "start_lease":
      return controller.startLease(request.payload);
    case "renew_lease":
      return controller.renewLease(request.payload);
    case "restore":
      return controller.restore(request.payload.reason);
  }
}
