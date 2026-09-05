import {
  parseWorkerRestorationReason,
  type WorkerRestorationReason,
} from "./worker-controller";

/** Maximum single UTF-8 JSON request or response frame. */
export const MAXIMUM_WORKER_CONTROLLER_SERIAL_FRAME_BYTES = 65_536;

export type WorkerControllerSerialRequestFor<Version extends string, Grant, Renewal> = {
  protocolVersion: Version;
  requestId: string;
} & (
  | { command: "discover" | "status" | "pause" | "cancel" }
  | { command: "start_lease"; payload: Grant }
  | { command: "renew_lease"; payload: Renewal }
  | { command: "restore"; payload: { reason: WorkerRestorationReason } }
  | { command: "transport_probe"; payload: { padding: string } }
);

export type WorkerControllerSerialResponseFor<Version extends string> =
  | {
      protocolVersion: Version;
      requestId: string;
      ok: true;
      result: unknown;
    }
  | {
      protocolVersion: Version;
      requestId: string;
      ok: false;
      error: { code: "invalid_request" | "command_rejected"; message: string };
    };

export type WorkerControllerSerialCodecProfile<Version extends string, Grant, Renewal> = {
  protocolVersion: Version;
  label: string;
  parseGrant(input: unknown): Grant;
  parseRenewal(input: unknown): Renewal;
};

export function encodeWorkerControllerSerialMessage(value: unknown): Uint8Array {
  const encoded = new TextEncoder().encode(`${JSON.stringify(value)}\n`);
  if (encoded.byteLength > MAXIMUM_WORKER_CONTROLLER_SERIAL_FRAME_BYTES) {
    throw new Error("Worker Controller Serial frame is too large");
  }
  return encoded;
}

export function decodeWorkerControllerSerialRequestFor<Version extends string, Grant, Renewal>(
  frame: Uint8Array,
  profile: WorkerControllerSerialCodecProfile<Version, Grant, Renewal>,
): WorkerControllerSerialRequestFor<Version, Grant, Renewal> {
  const value = exactRecord(
    decodeRecord(frame, profile.label),
    ["protocolVersion", "requestId", "command"],
    profile.label,
    ["payload"],
  );
  const requestId = parseEnvelope(value, profile);
  const command = value.command;
  if (typeof command !== "string") throw invalid(profile.label, "request");
  const requiresPayload = ["start_lease", "renew_lease", "restore", "transport_probe"].includes(command);
  if (requiresPayload !== ("payload" in value)) {
    throw invalid(profile.label, "request");
  }
  if (command === "transport_probe") {
    const payload = exactRecord(value.payload, ["padding"], profile.label);
    if (typeof payload.padding !== "string" || !/^x*$/u.test(payload.padding)) throw invalid(profile.label, "request");
    return { protocolVersion: profile.protocolVersion, requestId, command, payload: { padding: payload.padding } };
  }
  if (command === "start_lease") {
    return {
      protocolVersion: profile.protocolVersion,
      requestId,
      command,
      payload: profile.parseGrant(value.payload),
    };
  }
  if (command === "renew_lease") {
    return {
      protocolVersion: profile.protocolVersion,
      requestId,
      command,
      payload: profile.parseRenewal(value.payload),
    };
  }
  if (command === "restore") {
    const payload = exactRecord(value.payload, ["reason"], profile.label);
    return {
      protocolVersion: profile.protocolVersion,
      requestId,
      command,
      payload: { reason: parseWorkerRestorationReason(payload.reason) },
    };
  }
  if (["discover", "status", "pause", "cancel"].includes(command)) {
    return {
      protocolVersion: profile.protocolVersion,
      requestId,
      command: command as "discover" | "status" | "pause" | "cancel",
    };
  }
  throw invalid(profile.label, "request");
}

export function decodeWorkerControllerSerialResponseFor<Version extends string>(
  frame: Uint8Array,
  profile: WorkerControllerSerialCodecProfile<Version, unknown, unknown>,
): WorkerControllerSerialResponseFor<Version> {
  const decoded = decodeRecord(frame, profile.label);
  const requestId = parseEnvelope(decoded, profile);
  if (typeof decoded.ok !== "boolean") throw invalid(profile.label, "response");
  const value = exactRecord(
    decoded,
    decoded.ok
      ? ["protocolVersion", "requestId", "ok", "result"]
      : ["protocolVersion", "requestId", "ok", "error"],
    profile.label,
  );
  if (decoded.ok) {
    return {
      protocolVersion: profile.protocolVersion,
      requestId,
      ok: true,
      result: value.result,
    };
  }
  const error = exactRecord(value.error, ["code", "message"], profile.label);
  if (
    !["invalid_request", "command_rejected"].includes(String(error.code)) ||
    typeof error.message !== "string" ||
    error.message.length === 0 ||
    error.message.length > 256
  ) {
    throw invalid(profile.label, "response");
  }
  const code = String(error.code) as "invalid_request" | "command_rejected";
  return {
    protocolVersion: profile.protocolVersion,
    requestId,
    ok: false,
    error: {
      code,
      message:
        code === "invalid_request"
          ? "Worker Controller Serial request was invalid"
          : "Worker Controller command was rejected",
    },
  };
}

export function decodeWorkerControllerSerialEnvelopeFor<Version extends string>(
  frame: Uint8Array,
  profile: WorkerControllerSerialCodecProfile<Version, unknown, unknown>,
): { protocolVersion: Version; requestId: string } {
  const value = decodeRecord(frame, profile.label);
  return {
    protocolVersion: profile.protocolVersion,
    requestId: parseEnvelope(value, profile),
  };
}

export function assertWorkerControllerSerialCorrelationFor<Version extends string>(
  request: { requestId: string },
  response: { requestId: string },
  profile: WorkerControllerSerialCodecProfile<Version, unknown, unknown>,
): void {
  if (request.requestId !== response.requestId) {
    throw new Error(`${profile.label} response identity mismatch`);
  }
}

function decodeRecord(frame: Uint8Array, label: string): Record<string, unknown> {
  if (frame.byteLength === 0 || frame.byteLength > MAXIMUM_WORKER_CONTROLLER_SERIAL_FRAME_BYTES) {
    throw invalid(label, "frame");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(frame);
  } catch {
    throw invalid(label, "frame");
  }
  if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) {
    throw invalid(label, "frame");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(0, -1));
  } catch {
    throw invalid(label, "frame");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalid(label, "message");
  }
  return parsed as Record<string, unknown>;
}

function parseEnvelope<Version extends string>(
  value: Record<string, unknown>,
  profile: WorkerControllerSerialCodecProfile<Version, unknown, unknown>,
): string {
  if (
    value.protocolVersion !== profile.protocolVersion ||
    typeof value.requestId !== "string" ||
    value.requestId.length > 128 ||
    !/^serial_[A-Za-z0-9_-]+$/u.test(value.requestId)
  ) {
    throw invalid(profile.label, "envelope");
  }
  return value.requestId;
}

function exactRecord(
  input: unknown,
  required: readonly string[],
  label: string,
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalid(label, "message");
  }
  const value = input as Record<string, unknown>;
  const permitted = [...required, ...optional];
  const keys = Object.keys(value);
  if (
    keys.some((key) => !permitted.includes(key)) ||
    required.some((key) => !keys.includes(key))
  ) {
    throw invalid(label, "message");
  }
  return value;
}

function invalid(label: string, kind: string): Error {
  return new Error(`${label} ${kind} is invalid`);
}
