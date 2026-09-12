import { serialFailure } from "./worker-serial-errors";
export { serialFailure, serialFailureFor, workerSerialFailureCategory } from "./worker-serial-errors";
import { maybeWorkerSerialDiagnostic, type WorkerSerialDiagnostic } from "./worker-serial-diagnostics";
import { parseWorkerSerialJson, hasMalformedSerialJsonSyntax } from "./worker-serial-lexeme";
import { canonicalJson } from "./headless-values";
import { sha256Base64UrlBytes } from "./crypto-bytes";
import type { WorkerBrowserSerialTraceEpoch } from "./worker-browser-serial-trace";

export const WORKER_SERIAL_PROFILE = "bwg-worker-serial/0.2" as const;
export const MAXIMUM_SERIAL_CONTROL_PAYLOAD_BYTES = 65_536;
export const MAXIMUM_SERIAL_WIRE_BYTES = 66_560;
export const WORKER_SERIAL_MANIFEST = Object.freeze({
  profile: WORKER_SERIAL_PROFILE,
  qualificationAttemptProfile: "worker-qualification-attempt-v1",
  poolDifficultyHintProfile: "worker-stratum-difficulty-hint-v1",
  transport: "esp32s3_usb_serial_jtag",
  baudRate: 115_200,
  framing: "utf8_ndjson",
  maximumControlPayloadBytes: MAXIMUM_SERIAL_CONTROL_PAYLOAD_BYTES,
  maximumWireFrameBytes: MAXIMUM_SERIAL_WIRE_BYTES,
  heartbeatIntervalMilliseconds: 1_000,
  heartbeatTimeoutMilliseconds: 2_800,
  foregroundOnly: true,
  hostToDeviceReceiveWindowBytes: 2048,
  maximumHostWriteChunkBytes: 1024,
  recordWriteTimeoutMilliseconds: 2000,
  payloadIntegrity: "sha256_exact_utf8_json",
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
    "payloadBytes",
    "payloadSha256",
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
  if (!Number.isSafeInteger(value.payloadBytes) || Number(value.payloadBytes) < 2 ||
    Number(value.payloadBytes) > MAXIMUM_SERIAL_WIRE_BYTES || !serialNonce(value.payloadSha256))
    throw serialFailure("integrity");
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
export async function encodeWorkerSerialEnvelope(
  envelope: WorkerSerialEnvelope,
): Promise<Uint8Array> {
  const payloadJson = JSON.stringify(envelope.payload);
  const payloadUtf8 = new TextEncoder().encode(payloadJson);
  const { payload: _payload, ...header } = envelope;
  const metadata = { ...header, payloadBytes: payloadUtf8.length, payloadSha256: await sha256Base64UrlBytes(payloadUtf8) };
  const wire = { ...metadata, payload: JSON.parse(payloadJson) };
  parseWorkerSerialEnvelope(wire);
  const bytes = new TextEncoder().encode(
    `${JSON.stringify(metadata).slice(0, -1)},"payload":${payloadJson}}\n`,
  );
  if (bytes.length > MAXIMUM_SERIAL_WIRE_BYTES)
    throw serialFailure("wire_bound");
  return bytes;
}
/** Incremental bounded reader; startup text is discarded without public disclosure. */
export class WorkerSerialFramer {
  constructor(private readonly maybeDiagnostic?: (value: WorkerSerialDiagnostic) => void, private bootstrap = false, private readonly maybeTrace?: WorkerBrowserSerialTraceEpoch) { }
  #frameOrdinal = 0;
  #bytes = new Uint8Array(MAXIMUM_SERIAL_WIRE_BYTES);
  #length = 0;
  #discarding = false;
  #bootstrapPrefixDiscarded = false;
  #bootstrapDiscardedBytes = 0;
  get bootstrapDiscardedBytes(): number { return this.#bootstrapDiscardedBytes; }
  finishBootstrap(): void { this.bootstrap = false; }
  #countBootstrapBytes(bytes: number): void {
    this.#bootstrapDiscardedBytes += bytes;
    if (this.#bootstrapDiscardedBytes > MAXIMUM_SERIAL_WIRE_BYTES) throw serialFailure("wire_bound");
  }
  #discardBootstrapPrefix(bytes: number): boolean {
    if (!this.bootstrap || this.#bootstrapPrefixDiscarded) return false;
    this.#countBootstrapBytes(bytes);
    this.#bootstrapPrefixDiscarded = true;
    return true;
  }
  async push(chunk: Uint8Array, maybeReceive?: (frame: WorkerSerialEnvelope, frameOrdinal: number) => void): Promise<WorkerSerialEnvelope[]> {
    const result: WorkerSerialEnvelope[] = [];
    for (const [index, byte] of chunk.entries()) {
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
      const frameOrdinal = ++this.#frameOrdinal;
      this.maybeTrace?.record("frame_assembled", bytes.length + 1, chunk.length - index - 1, frameOrdinal);
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        if (this.#discardBootstrapPrefix(bytes.length + 1)) continue;
        throw serialFailure("utf8");
      }
      if (!text.trimStart().startsWith("{")) {
        if (this.bootstrap) this.#countBootstrapBytes(bytes.length + 1);
        const maybeDiagnostic = maybeWorkerSerialDiagnostic(text);
        if (maybeDiagnostic) this.maybeDiagnostic?.(maybeDiagnostic);
        continue;
      }
      if (text.includes("\r")) throw serialFailure("line_ending");
      let parsed: ReturnType<typeof parseWorkerSerialJson>;
      try { parsed = parseWorkerSerialJson(text); }
      catch (error) {
        if (hasMalformedSerialJsonSyntax(text) && this.#discardBootstrapPrefix(bytes.length + 1)) continue;
        throw error;
      }
      const value = parsed.value;
      const record = serialRecord(value);
      if (record.profile !== WORKER_SERIAL_PROFILE)
        throw serialFailure("profile");
      this.maybeTrace?.record("validation_started", bytes.length + 1, chunk.length - index - 1, frameOrdinal);
      let frame: WorkerSerialEnvelope;
      try {
        if (record.payloadBytes !== parsed.payloadBytes || record.payloadSha256 !== await sha256Base64UrlBytes(parsed.payloadUtf8)) throw serialFailure("integrity");
        if (record.kind === "control" && parsed.payloadBytes > MAXIMUM_SERIAL_CONTROL_PAYLOAD_BYTES) throw serialFailure("payload_bound");
        frame = parseWorkerSerialEnvelope(record);
      } catch (error) {
        this.maybeTrace?.record("validation_rejected", bytes.length + 1, chunk.length - index - 1, frameOrdinal);
        throw error;
      }
      this.maybeTrace?.record("validation_completed", bytes.length + 1, chunk.length - index - 1, frameOrdinal);
      // Admission runs synchronously at this delimiter, before the next record is parsed.
      if (maybeReceive) maybeReceive(frame, frameOrdinal);
      else {
        if (frame.kind === "session" && frame.payload.op === "hello_ack") this.finishBootstrap();
        result.push(frame);
      }
      if (this.bootstrap) this.#countBootstrapBytes(bytes.length + 1);
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
