import {
  WORKER_CONTROLLER_PROTOCOL_VERSION,
  type WorkerController,
  type WorkerControllerDisconnectReason,
} from "./worker-controller";
import {
  decodeWorkerControllerSerialEnvelope,
  decodeWorkerControllerSerialRequest,
  encodeWorkerControllerSerialMessage,
  type WorkerControllerSerialExchange,
  type WorkerControllerSerialResponse,
} from "./worker-controller-serial";

/** Simulator-backed USB exchange with an explicit device-local disconnect event. */
export class SimulatedWorkerControllerSerialExchange implements WorkerControllerSerialExchange {
  readonly #controller: WorkerController;
  readonly #disconnectListeners = new Set<
    (reason: WorkerControllerDisconnectReason) => Promise<void>
  >();

  constructor(controller: WorkerController) {
    this.#controller = controller;
  }

  async transact(frame: Uint8Array): Promise<Uint8Array> {
    let requestId = "serial_invalid";
    try {
      requestId = decodeWorkerControllerSerialEnvelope(frame).requestId;
      const request = decodeWorkerControllerSerialRequest(frame);
      const result = await dispatch(this.#controller, request);
      return encodeWorkerControllerSerialMessage({
        protocolVersion: WORKER_CONTROLLER_PROTOCOL_VERSION,
        requestId,
        ok: true,
        result,
      } satisfies WorkerControllerSerialResponse);
    } catch {
      return encodeWorkerControllerSerialMessage({
        protocolVersion: WORKER_CONTROLLER_PROTOCOL_VERSION,
        requestId,
        ok: false,
        error: { code: "command_rejected", message: "Worker Controller command was rejected" },
      } satisfies WorkerControllerSerialResponse);
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

/** Creates one simulator-backed exchange suitable for SerialWorkerController conformance. */
export function simulatedWorkerControllerSerialExchange(
  controller: WorkerController,
): SimulatedWorkerControllerSerialExchange {
  return new SimulatedWorkerControllerSerialExchange(controller);
}

async function dispatch(
  controller: WorkerController,
  request: ReturnType<typeof decodeWorkerControllerSerialRequest>,
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
