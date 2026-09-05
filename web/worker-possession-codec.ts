import {
  parseWorkerPossessionRequest,
  parseWorkerPossessionResponse,
  type WorkerPossessionRequest,
  type WorkerPossessionResponse,
} from "./worker-possession";

/** Maximum single UTF-8 JSON possession request or response frame. */
export const MAXIMUM_WORKER_POSSESSION_FRAME_BYTES = 65_536;

/** Encodes one complete bounded possession JSON-plus-LF frame. */
export function encodeWorkerPossessionMessage(value: unknown): Uint8Array {
  const bytes = new TextEncoder().encode(`${JSON.stringify(value)}\n`);
  if (bytes.byteLength > MAXIMUM_WORKER_POSSESSION_FRAME_BYTES) {
    throw new Error("Worker possession frame is too large");
  }
  return bytes;
}

/** Decodes one complete possession request without accepting a log or second frame. */
export function decodeWorkerPossessionRequest(frame: Uint8Array): WorkerPossessionRequest {
  return parseWorkerPossessionRequest(decodeFrame(frame));
}

/** Decodes one complete possession response and replaces device-supplied failure text. */
export function decodeWorkerPossessionResponse(frame: Uint8Array): WorkerPossessionResponse {
  return parseWorkerPossessionResponse(decodeFrame(frame));
}

function decodeFrame(frame: Uint8Array): unknown {
  if (frame.byteLength === 0 || frame.byteLength > MAXIMUM_WORKER_POSSESSION_FRAME_BYTES) {
    throw invalidFrame();
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(frame);
  } catch {
    throw invalidFrame();
  }
  if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) throw invalidFrame();
  try {
    return JSON.parse(text.slice(0, -1)) as unknown;
  } catch {
    throw invalidFrame();
  }
}

function invalidFrame(): Error {
  return new Error("Worker possession frame is invalid");
}
