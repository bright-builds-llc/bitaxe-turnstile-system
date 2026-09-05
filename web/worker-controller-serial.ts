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
  MAXIMUM_WORKER_CONTROLLER_SERIAL_FRAME_BYTES,
  assertWorkerControllerSerialCorrelationFor,
  decodeWorkerControllerSerialEnvelopeFor,
  decodeWorkerControllerSerialRequestFor,
  decodeWorkerControllerSerialResponseFor,
  encodeWorkerControllerSerialMessage as encodeUsbMessage,
  type WorkerControllerSerialRequestFor,
  type WorkerControllerSerialResponseFor,
} from "./worker-controller-serial-codec";

export { MAXIMUM_WORKER_CONTROLLER_SERIAL_FRAME_BYTES };

/** Strict request envelope sent over a user-authorized local USB exchange. */
export type WorkerControllerSerialRequest = WorkerControllerSerialRequestFor<
  typeof WORKER_CONTROLLER_PROTOCOL_VERSION,
  WorkerLeaseGrant,
  WorkerLeaseRenewal
>;

/** Strict response envelope whose errors are normalized before application exposure. */
export type WorkerControllerSerialResponse = WorkerControllerSerialResponseFor<
  typeof WORKER_CONTROLLER_PROTOCOL_VERSION
>;

/** Transport port supplied by Web Serial or a deterministic conformance exchange. */
export interface WorkerControllerSerialExchange {
  /** Exchanges exactly one complete request for one complete response. */
  transact(request: Uint8Array): Promise<Uint8Array>;
  /** Observes transport loss after firmware has applied device-local restoration. */
  subscribeDisconnect(
    listener: (reason: WorkerControllerDisconnectReason) => Promise<void>,
  ): () => void;
}

const controllerCodec = {
  protocolVersion: WORKER_CONTROLLER_PROTOCOL_VERSION,
  label: "Worker Controller Serial",
  parseGrant: parseWorkerLeaseGrant,
  parseRenewal: parseWorkerLeaseRenewal,
};

/** WorkerController implementation over bounded request/response USB frames. */
export class SerialWorkerController implements WorkerController {
  readonly #exchange: WorkerControllerSerialExchange;
  #sequence = 0;

  constructor(exchange: WorkerControllerSerialExchange) {
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

  async #request(command: WorkerControllerSerialRequest["command"], maybePayload?: unknown) {
    const requestId = `serial_${String(++this.#sequence)}`;
    const request = {
      protocolVersion: WORKER_CONTROLLER_PROTOCOL_VERSION,
      requestId,
      command,
      ...(maybePayload === undefined ? {} : { payload: maybePayload }),
    } as WorkerControllerSerialRequest;
    const response = decodeWorkerControllerSerialResponse(
      await this.#exchange.transact(encodeWorkerControllerSerialMessage(request)),
    );
    assertWorkerControllerSerialCorrelationFor(request, response, controllerCodec);
    if (!response.ok) {
      throw new Error(
        response.error.code === "invalid_request"
          ? "Worker Controller Serial request was invalid"
          : "Worker Controller command was rejected",
      );
    }
    return response.result;
  }
}

/** Encodes exactly one bounded UTF-8 JSON-lines frame. */
export function encodeWorkerControllerSerialMessage(value: unknown): Uint8Array {
  return encodeUsbMessage(value);
}

/** Parses one untrusted USB request into the closed request union. */
export function decodeWorkerControllerSerialRequest(frame: Uint8Array): WorkerControllerSerialRequest {
  return decodeWorkerControllerSerialRequestFor(frame, controllerCodec);
}

/** Parses one untrusted USB response and replaces device-supplied error text. */
export function decodeWorkerControllerSerialResponse(frame: Uint8Array): WorkerControllerSerialResponse {
  return decodeWorkerControllerSerialResponseFor(frame, controllerCodec);
}

/** Parses only a bounded envelope so invalid payloads can receive a correlated safe error. */
export function decodeWorkerControllerSerialEnvelope(frame: Uint8Array): {
  protocolVersion: typeof WORKER_CONTROLLER_PROTOCOL_VERSION;
  requestId: string;
} {
  return decodeWorkerControllerSerialEnvelopeFor(frame, controllerCodec);
}
