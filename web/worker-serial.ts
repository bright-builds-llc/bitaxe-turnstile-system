import { maybeWorkerSerialDiagnostic, type WorkerSerialDiagnostic } from "./worker-serial-diagnostics";
import { parseWorkerSerialJson } from "./worker-serial-lexeme";
import { canonicalJson } from "./headless-values";
import { sha256Base64UrlBytes } from "./crypto-bytes";

export const WORKER_SERIAL_PROFILE = "bwg-worker-serial/0.1" as const;
export const MAXIMUM_SERIAL_CONTROL_PAYLOAD_BYTES = 65_536;
export const MAXIMUM_SERIAL_WIRE_BYTES = 66_560;
export const WORKER_SERIAL_MANIFEST = Object.freeze({
  profile: WORKER_SERIAL_PROFILE,
  transport: "esp32s3_usb_serial_jtag",
  baudRate: 115_200,
  framing: "utf8_ndjson",
  maximumControlPayloadBytes: MAXIMUM_SERIAL_CONTROL_PAYLOAD_BYTES,
  maximumWireFrameBytes: MAXIMUM_SERIAL_WIRE_BYTES,
  heartbeatIntervalMilliseconds: 1_000,
  heartbeatTimeoutMilliseconds: 2_800,
  foregroundOnly: true,
} as const);
export type WorkerSerialManifest = typeof WORKER_SERIAL_MANIFEST;
export type WorkerSerialKind =
  | "session"
  | "control"
  | "heartbeat"
  | "diagnostic";
export type WorkerSerialEnvelope = {
  profile: typeof WORKER_SERIAL_PROFILE;
  kind: WorkerSerialKind;
  sessionId: string | null;
  sequence: number;
  payload: Record<string, unknown>;
};

/** Admits exactly the signed fixed-Serial/JTAG application manifest. */
export function parseWorkerSerialManifest(
  input: unknown,
): WorkerSerialManifest {
  if (canonicalJson(input) !== canonicalJson(WORKER_SERIAL_MANIFEST))
    throw serialFailure("manifest");
  return WORKER_SERIAL_MANIFEST;
}
export function workerSerialManifestSha256(
  manifest: WorkerSerialManifest = WORKER_SERIAL_MANIFEST,
) {
  return sha256Base64UrlBytes(
    new TextEncoder().encode(
      canonicalJson(parseWorkerSerialManifest(manifest)),
    ),
  );
}
export function serialToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{21}[AQgw]$/u.test(value);
}
export function serialNonce(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(value)
  );
}
export function serialRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw serialFailure("shape");
  return input as Record<string, unknown>;
}
export function exactSerialRecord(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  const value = serialRecord(input);
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw serialFailure("fields");
  return value;
}
/** Validates framing independently from the caller's active session and sequence. */
export function parseWorkerSerialEnvelope(
  input: unknown,
): WorkerSerialEnvelope {
  const value = exactSerialRecord(input, [
    "profile",
    "kind",
    "sessionId",
    "sequence",
    "payload",
  ]);
  if (
    value.profile !== WORKER_SERIAL_PROFILE ||
    !["session", "control", "heartbeat", "diagnostic"].includes(
      String(value.kind),
    ) ||
    !Number.isSafeInteger(value.sequence) ||
    Number(value.sequence) < 0 ||
    Number(value.sequence) > 0xffff_ffff
  )
    throw serialFailure("envelope");
  const payload = serialRecord(value.payload);
  const hello = value.kind === "session" && payload.op === "hello";
  if (
    hello
      ? value.sessionId !== null || value.sequence !== 0
      : !serialToken(value.sessionId)
  )
    throw serialFailure("session");
  if (value.kind === "heartbeat" && Object.keys(payload).length !== 0)
    throw serialFailure("heartbeat");
  if (
    value.kind === "control" &&
    new TextEncoder().encode(JSON.stringify(payload)).length >
    MAXIMUM_SERIAL_CONTROL_PAYLOAD_BYTES
  )
    throw serialFailure("payload_bound");
  return {
    profile: WORKER_SERIAL_PROFILE,
    kind: value.kind as WorkerSerialKind,
    sessionId: value.sessionId as string | null,
    sequence: Number(value.sequence),
    payload,
  };
}
export function encodeWorkerSerialEnvelope(
  envelope: WorkerSerialEnvelope,
): Uint8Array {
  const bytes = new TextEncoder().encode(
    `${JSON.stringify(parseWorkerSerialEnvelope(envelope))}\n`,
  );
  if (bytes.length > MAXIMUM_SERIAL_WIRE_BYTES)
    throw serialFailure("wire_bound");
  return bytes;
}
/** Incremental bounded reader; startup text is discarded without public disclosure. */
export class WorkerSerialFramer {
  constructor(private readonly maybeDiagnostic?: (value: WorkerSerialDiagnostic) => void) { }
  #bytes = new Uint8Array(MAXIMUM_SERIAL_WIRE_BYTES);
  #length = 0;
  #discarding = false;
  push(chunk: Uint8Array): WorkerSerialEnvelope[] {
    const result: WorkerSerialEnvelope[] = [];
    for (const byte of chunk) {
      if (this.#discarding) {
        if (byte === 10) this.#discarding = false;
        continue;
      }
      if (this.#length >= this.#bytes.length) {
        this.#length = 0;
        this.#discarding = byte !== 10;
        throw serialFailure("wire_bound");
      }
      this.#bytes[this.#length++] = byte;
      if (byte !== 10) continue;
      const bytes = this.#bytes.slice(0, this.#length - 1);
      this.#length = 0;
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw serialFailure("utf8");
      }
      if (!text.trimStart().startsWith("{")) {
        const maybeDiagnostic = maybeWorkerSerialDiagnostic(text);
        if (maybeDiagnostic) this.maybeDiagnostic?.(maybeDiagnostic);
        continue;
      }
      if (text.includes("\r")) throw serialFailure("line_ending");
      const parsed = parseWorkerSerialJson(text);
      const value = parsed.value;
      const record = serialRecord(value);
      if (record.profile !== WORKER_SERIAL_PROFILE)
        throw serialFailure("profile");
      if (
        record.kind === "control" &&
        parsed.payloadBytes > MAXIMUM_SERIAL_CONTROL_PAYLOAD_BYTES
      )
        throw serialFailure("payload_bound");
      result.push(parseWorkerSerialEnvelope(record));
    }
    return result;
  }
  clear(): void {
    this.#length = 0;
    this.#discarding = false;
  }
}
/** Monotonic peer liveness, independent of outgoing traffic or command completion. */
export class WorkerSerialPeer {
  #lastSequence = 0;
  #lastHeartbeat: number;
  #revoked = false;
  constructor(
    readonly sessionId: string,
    now: number,
  ) {
    if (!serialToken(sessionId) || !Number.isFinite(now) || now < 0)
      throw serialFailure("session");
    this.#lastHeartbeat = now;
  }
  receive(envelope: WorkerSerialEnvelope, now: number): void {
    if (
      this.expired(now) ||
      envelope.sessionId !== this.sessionId ||
      envelope.sequence <= this.#lastSequence
    ) {
      this.#revoked = true;
      throw serialFailure("continuity");
    }
    this.#lastSequence = envelope.sequence;
    if (envelope.kind === "heartbeat") this.#lastHeartbeat = now;
  }
  expired(now: number): boolean {
    if (
      !Number.isFinite(now) ||
      now < this.#lastHeartbeat ||
      now - this.#lastHeartbeat >= 2_800
    )
      this.#revoked = true;
    return this.#revoked;
  }
  revoke(): void {
    this.#revoked = true;
  }
}
export function serialFailure(category: string): Error {
  return new Error(`Worker Serial ${category}`);
}
