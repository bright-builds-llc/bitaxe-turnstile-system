import {
  WORKER_CONTROLLER_PROTOCOL_VERSION,
  type WorkerController,
  type WorkerControllerCapabilities,
  type WorkerControllerDisconnectReason,
  type WorkerControllerStatus,
  type WorkerLeaseGrant,
  type WorkerLeaseRenewal,
  type WorkerRestorationReason,
  parseWorkerControllerCapabilities,
  parseWorkerControllerStatus,
  parseWorkerLeaseGrant,
  parseWorkerLeaseRenewal,
  parseWorkerRestorationReason,
} from "./worker-controller";

/** Maximum single UTF-8 JSON-lines request or response frame. */
export const MAXIMUM_WORKER_CONTROLLER_USB_FRAME_BYTES = 65_536;

/** Strict request envelope sent over a user-authorized local USB exchange. */
export type WorkerControllerUsbRequest = {
  protocolVersion: typeof WORKER_CONTROLLER_PROTOCOL_VERSION;
  requestId: string;
} & (
  | { command: "discover" | "status" | "pause" | "cancel" }
  | { command: "start_lease"; payload: WorkerLeaseGrant }
  | { command: "renew_lease"; payload: WorkerLeaseRenewal }
  | { command: "restore"; payload: { reason: WorkerRestorationReason } }
);

/** Strict response envelope whose errors are normalized before application exposure. */
export type WorkerControllerUsbResponse =
  | {
      protocolVersion: typeof WORKER_CONTROLLER_PROTOCOL_VERSION;
      requestId: string;
      ok: true;
      result: unknown;
    }
  | {
      protocolVersion: typeof WORKER_CONTROLLER_PROTOCOL_VERSION;
      requestId: string;
      ok: false;
      error: { code: "invalid_request" | "command_rejected"; message: string };
    };

/** Transport port supplied by Web Serial or a deterministic conformance exchange. */
export interface WorkerControllerUsbExchange {
  /** Exchanges exactly one complete request for one complete response. */
  transact(request: Uint8Array): Promise<Uint8Array>;
  /** Observes transport loss after firmware has applied device-local restoration. */
  subscribeDisconnect(
    listener: (reason: WorkerControllerDisconnectReason) => Promise<void>,
  ): () => void;
}

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
    if (response.requestId !== requestId) {
      throw new Error("Worker Controller USB response identity mismatch");
    }
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
  const encoded = new TextEncoder().encode(`${JSON.stringify(value)}\n`);
  if (encoded.byteLength > MAXIMUM_WORKER_CONTROLLER_USB_FRAME_BYTES) {
    throw new Error("Worker Controller USB frame is too large");
  }
  return encoded;
}

/** Parses one untrusted USB request into the closed request union. */
export function decodeWorkerControllerUsbRequest(frame: Uint8Array): WorkerControllerUsbRequest {
  return decodeMessage(frame, parseRequest);
}

/** Parses one untrusted USB response and replaces device-supplied error text. */
export function decodeWorkerControllerUsbResponse(frame: Uint8Array): WorkerControllerUsbResponse {
  return decodeMessage(frame, parseResponse);
}

/** Parses only a bounded envelope so invalid payloads can receive a correlated safe error. */
export function decodeWorkerControllerUsbEnvelope(frame: Uint8Array): {
  protocolVersion: typeof WORKER_CONTROLLER_PROTOCOL_VERSION;
  requestId: string;
} {
  return decodeMessage(frame, (value) => ({
    protocolVersion: WORKER_CONTROLLER_PROTOCOL_VERSION,
    requestId: parseEnvelope(value),
  }));
}

function decodeMessage<T>(
  frame: Uint8Array,
  parse: (value: Record<string, unknown>) => T,
): T {
  if (frame.byteLength === 0 || frame.byteLength > MAXIMUM_WORKER_CONTROLLER_USB_FRAME_BYTES) {
    throw new Error("Worker Controller USB frame is invalid");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(frame);
  if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) {
    throw new Error("Worker Controller USB frame is invalid");
  }
  const value: unknown = JSON.parse(text.slice(0, -1));
  if (!isRecord(value)) throw new Error("Worker Controller USB message is invalid");
  return parse(value);
}

function parseRequest(value: Record<string, unknown>): WorkerControllerUsbRequest {
  const requestId = parseEnvelope(value);
  const commands = [
    "discover",
    "status",
    "pause",
    "cancel",
    "start_lease",
    "renew_lease",
    "restore",
  ];
  if (typeof value.command !== "string" || !commands.includes(value.command)) {
    throw new Error("Worker Controller USB request is invalid");
  }
  const requiresPayload = ["start_lease", "renew_lease", "restore"].includes(value.command);
  if (requiresPayload !== ("payload" in value)) {
    throw new Error("Worker Controller USB request is invalid");
  }
  const permitted = requiresPayload
    ? ["protocolVersion", "requestId", "command", "payload"]
    : ["protocolVersion", "requestId", "command"];
  if (Object.keys(value).some((key) => !permitted.includes(key))) {
    throw new Error("Worker Controller USB request is invalid");
  }
  if (value.command === "start_lease") {
    return {
      protocolVersion: WORKER_CONTROLLER_PROTOCOL_VERSION,
      requestId,
      command: "start_lease",
      payload: parseWorkerLeaseGrant(value.payload),
    };
  }
  if (value.command === "renew_lease") {
    return {
      protocolVersion: WORKER_CONTROLLER_PROTOCOL_VERSION,
      requestId,
      command: "renew_lease",
      payload: parseWorkerLeaseRenewal(value.payload),
    };
  }
  if (value.command === "restore") {
    const payload = value.payload;
    if (
      !isRecord(payload) ||
      Object.keys(payload).some((key) => key !== "reason") ||
      typeof payload.reason !== "string"
    ) {
      throw new Error("Worker Controller USB request is invalid");
    }
    return {
      protocolVersion: WORKER_CONTROLLER_PROTOCOL_VERSION,
      requestId,
      command: "restore",
      payload: { reason: parseWorkerRestorationReason(payload.reason) },
    };
  }
  return {
    protocolVersion: WORKER_CONTROLLER_PROTOCOL_VERSION,
    requestId,
    command: value.command as "discover" | "status" | "pause" | "cancel",
  };
}

function parseResponse(value: Record<string, unknown>): WorkerControllerUsbResponse {
  const requestId = parseEnvelope(value);
  if (typeof value.ok !== "boolean") {
    throw new Error("Worker Controller USB response is invalid");
  }
  if (value.ok !== ("result" in value) || value.ok === ("error" in value)) {
    throw new Error("Worker Controller USB response is invalid");
  }
  const permitted = value.ok
    ? ["protocolVersion", "requestId", "ok", "result"]
    : ["protocolVersion", "requestId", "ok", "error"];
  if (Object.keys(value).some((key) => !permitted.includes(key))) {
    throw new Error("Worker Controller USB response is invalid");
  }
  if (!value.ok) {
    const error = value.error;
    if (
      !isRecord(error) ||
      Object.keys(error).some((key) => !["code", "message"].includes(key)) ||
      !["invalid_request", "command_rejected"].includes(String(error.code)) ||
      typeof error.message !== "string" ||
      error.message.length === 0 ||
      error.message.length > 256
    ) {
      throw new Error("Worker Controller USB response is invalid");
    }
    const code = String(error.code) as "invalid_request" | "command_rejected";
    return {
      protocolVersion: WORKER_CONTROLLER_PROTOCOL_VERSION,
      requestId,
      ok: false,
      error: {
        code,
        message:
          code === "invalid_request"
            ? "Worker Controller USB request was invalid"
            : "Worker Controller command was rejected",
      },
    };
  }
  return {
    protocolVersion: WORKER_CONTROLLER_PROTOCOL_VERSION,
    requestId,
    ok: true,
    result: value.result,
  };
}

function parseEnvelope(value: Record<string, unknown>): string {
  if (
    value.protocolVersion !== WORKER_CONTROLLER_PROTOCOL_VERSION ||
    typeof value.requestId !== "string" ||
    value.requestId.length > 128 ||
    !/^usb_[A-Za-z0-9_-]+$/u.test(value.requestId)
  ) {
    throw new Error("Worker Controller USB envelope is invalid");
  }
  return value.requestId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
