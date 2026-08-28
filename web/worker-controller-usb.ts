import {
  WORKER_CONTROLLER_PROTOCOL_VERSION,
  parseWorkerControllerCapabilities,
  parseWorkerControllerStatus,
  parseWorkerLeaseGrant,
  parseWorkerLeaseRenewal,
  type WorkerController,
  type WorkerControllerCapabilities,
  type WorkerControllerDisconnectReason,
  type WorkerControllerStatus,
  type WorkerLeaseGrant,
  type WorkerLeaseRenewal,
  type WorkerRestorationReason,
} from "./worker-controller";
import {
  MAXIMUM_WORKER_CONTROLLER_USB_FRAME_BYTES,
  assertWorkerControllerUsbCorrelationFor,
  decodeWorkerControllerUsbEnvelopeFor,
  decodeWorkerControllerUsbRequestFor,
  decodeWorkerControllerUsbResponseFor,
  encodeWorkerControllerUsbMessage as encodeUsbMessage,
  type WorkerControllerUsbRequestFor,
  type WorkerControllerUsbResponseFor,
} from "./worker-controller-usb-codec";

export { MAXIMUM_WORKER_CONTROLLER_USB_FRAME_BYTES };

/** Strict request envelope sent over a user-authorized local USB exchange. */
export type WorkerControllerUsbRequest = WorkerControllerUsbRequestFor<
  typeof WORKER_CONTROLLER_PROTOCOL_VERSION,
  WorkerLeaseGrant,
  WorkerLeaseRenewal
>;

/** Strict response envelope whose errors are normalized before application exposure. */
export type WorkerControllerUsbResponse = WorkerControllerUsbResponseFor<
  typeof WORKER_CONTROLLER_PROTOCOL_VERSION
>;

/** Transport port supplied by Web Serial or a deterministic conformance exchange. */
export interface WorkerControllerUsbExchange {
  /** Exchanges exactly one complete request for one complete response. */
  transact(request: Uint8Array): Promise<Uint8Array>;
  /** Observes transport loss after firmware has applied device-local restoration. */
  subscribeDisconnect(
    listener: (reason: WorkerControllerDisconnectReason) => Promise<void>,
  ): () => void;
}

const controllerV01Codec = {
  protocolVersion: WORKER_CONTROLLER_PROTOCOL_VERSION,
  label: "Worker Controller USB",
  parseGrant: parseWorkerLeaseGrant,
  parseRenewal: parseWorkerLeaseRenewal,
};

/** WorkerController implementation over bounded request/response USB frames. */
export class UsbWorkerController implements WorkerController {
  readonly #exchange: WorkerControllerUsbExchange;
  #sequence = 0;

  constructor(exchange: WorkerControllerUsbExchange) {
    this.#exchange = exchange;
  }

  async discover(): Promise<WorkerControllerCapabilities> {
    return parseWorkerControllerCapabilities(await this.#request("discover"));
  }

  async startLease(grant: WorkerLeaseGrant): Promise<WorkerControllerStatus> {
    return this.#statusRequest("start_lease", grant);
  }

  async renewLease(renewal: WorkerLeaseRenewal): Promise<WorkerControllerStatus> {
    return this.#statusRequest("renew_lease", renewal);
  }

  async status(): Promise<WorkerControllerStatus> {
    return this.#statusRequest("status");
  }

  async pause(): Promise<WorkerControllerStatus> {
    return this.#statusRequest("pause");
  }

  async cancel(): Promise<WorkerControllerStatus> {
    return this.#statusRequest("cancel");
  }

  async restore(reason: WorkerRestorationReason): Promise<WorkerControllerStatus> {
    return this.#statusRequest("restore", { reason });
  }

  subscribeDisconnect(
    listener: (reason: WorkerControllerDisconnectReason) => Promise<void>,
  ): () => void {
    return this.#exchange.subscribeDisconnect(listener);
  }

  async #statusRequest(
    command: "start_lease" | "renew_lease" | "status" | "pause" | "cancel" | "restore",
    maybePayload?: unknown,
  ): Promise<WorkerControllerStatus> {
    return parseWorkerControllerStatus(await this.#request(command, maybePayload));
  }

  async #request(command: WorkerControllerUsbRequest["command"], maybePayload?: unknown) {
    const requestId = `usb_${String(++this.#sequence)}`;
    const request = {
      protocolVersion: WORKER_CONTROLLER_PROTOCOL_VERSION,
      requestId,
      command,
      ...(maybePayload === undefined ? {} : { payload: maybePayload }),
    } as WorkerControllerUsbRequest;
    const response = decodeWorkerControllerUsbResponse(
      await this.#exchange.transact(encodeWorkerControllerUsbMessage(request)),
    );
    assertWorkerControllerUsbCorrelationFor(request, response, controllerV01Codec);
    if (!response.ok) {
      throw new Error(
        response.error.code === "invalid_request"
          ? "Worker Controller USB request was invalid"
          : "Worker Controller command was rejected",
      );
    }
    return response.result;
  }
}

/** Encodes exactly one bounded UTF-8 JSON-lines frame. */
export function encodeWorkerControllerUsbMessage(value: unknown): Uint8Array {
  return encodeUsbMessage(value);
}

/** Parses one untrusted USB request into the closed request union. */
export function decodeWorkerControllerUsbRequest(frame: Uint8Array): WorkerControllerUsbRequest {
  return decodeWorkerControllerUsbRequestFor(frame, controllerV01Codec);
}

/** Parses one untrusted USB response and replaces device-supplied error text. */
export function decodeWorkerControllerUsbResponse(frame: Uint8Array): WorkerControllerUsbResponse {
  return decodeWorkerControllerUsbResponseFor(frame, controllerV01Codec);
}

/** Parses only a bounded envelope so invalid payloads can receive a correlated safe error. */
export function decodeWorkerControllerUsbEnvelope(frame: Uint8Array): {
  protocolVersion: typeof WORKER_CONTROLLER_PROTOCOL_VERSION;
  requestId: string;
} {
  return decodeWorkerControllerUsbEnvelopeFor(frame, controllerV01Codec);
}
