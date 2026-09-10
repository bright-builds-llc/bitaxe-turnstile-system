import { WORKER_SERIAL_PROFILE, exactSerialRecord, parseWorkerSerialManifest, serialNonce, serialFailure, type WorkerSerialEnvelope } from "./worker-serial";
import type { Ack } from "./worker-serial-controller.types";
import { parseWorkerControlRejection } from "./worker-control-rejection";
import { boundedSerial, observeSerialOutcome, type WorkerSerialChannel } from "./webserial-worker-port";
import { parseWorkerPossessionResponse, WORKER_POSSESSION_PROFILE } from "./worker-possession";

/** Native output from a retired session grants no authority during a fresh Hello. */
export class WorkerSerialHelloBacklog {
  #ignored = 0;
  get discardedRecords(): number { return this.#ignored; }
  ignore(frame: WorkerSerialEnvelope, hostNonce: string): boolean {
    if (frame.kind === "session" && frame.payload.op === "hello_ack") {
      if (frame.payload.hostNonce === hostNonce) return false;
      if (!serialNonce(frame.payload.hostNonce)) throw serialFailure("hello_ack");
      parseWorkerSerialHelloAck(frame, frame.payload.hostNonce);
    } else {
      if (!frame.sessionId || frame.sequence === 0) throw serialFailure("envelope");
      if (frame.kind === "session") {
        const credit = exactSerialRecord(frame.payload, ["op", "receivedBytes"]);
        if (credit.op !== "receive_credit" || !Number.isSafeInteger(credit.receivedBytes) ||
          Number(credit.receivedBytes) <= 0 || Number(credit.receivedBytes) > 0xffffffff)
          throw serialFailure("credit_invalid");
      }
      if (frame.kind === "control" && frame.payload.profile === WORKER_POSSESSION_PROFILE) {
        // This validates an old response's shape only; fresh possession is still mandatory.
        parseWorkerPossessionResponse(frame.payload);
      } else if (frame.kind === "control") {
        const reply = exactSerialRecord(frame.payload, frame.payload.ok === true
          ? ["protocolVersion", "requestId", "ok", "result"]
          : ["protocolVersion", "requestId", "ok", "error"]);
        if (reply.protocolVersion !== "bwg-worker-controller/0.4" ||
          typeof reply.requestId !== "string" || reply.requestId.length > 128 ||
          !/^serial_[A-Za-z0-9_-]+$/u.test(reply.requestId) ||
          typeof reply.ok !== "boolean") throw serialFailure("fields");
        if (!reply.ok) parseWorkerControlRejection(reply.error);
      }
    }
    if (++this.#ignored > 32) throw serialFailure("wire_bound");
    return true;
  }
}

type HelloAdmission = ReturnType<typeof parseWorkerSerialHelloAck>;

/** One Hello deadline includes native send and backlog processing; neither renews it. */
export async function exchangeWorkerSerialHello(channel: WorkerSerialChannel, exchange: WorkerSerialHelloExchange, hostNonce: string): Promise<HelloAdmission> {
  const outcome = observeSerialOutcome(boundedSerial(exchange.result, 2_800));
  await channel.send({ profile: WORKER_SERIAL_PROFILE, kind: "session", sessionId: null, sequence: 0, payload: { op: "hello", hostNonce } });
  const received = await outcome;
  if (!received.ok) throw received.error;
  return received.value;
}

/** Atomically validates Hello, installs the peer, then ends bootstrap before waking callers. */
export class WorkerSerialHelloExchange {
  readonly result: Promise<HelloAdmission>;
  readonly #backlog = new WorkerSerialHelloBacklog();
  #maybeWaiting: { resolve(value: HelloAdmission): void; reject(error: Error): void } | undefined;
  get discardedRecords(): number { return this.#backlog.discardedRecords; }

  constructor(
    private readonly hostNonce: string,
    private readonly validate: (frame: WorkerSerialEnvelope) => HelloAdmission,
    private readonly admitted: (value: HelloAdmission) => void,
  ) {
    this.result = new Promise((resolve, reject) => { this.#maybeWaiting = { resolve, reject }; });
  }

  receive(frame: WorkerSerialEnvelope): boolean {
    const pending = this.#maybeWaiting;
    if (!pending) return false;
    if (this.#backlog.ignore(frame, this.hostNonce)) return true;
    const admission = this.validate(frame);
    this.admitted(admission);
    this.#maybeWaiting = undefined;
    pending.resolve(admission);
    return true;
  }

  reject(error: Error): void {
    const pending = this.#maybeWaiting;
    this.#maybeWaiting = undefined;
    pending?.reject(error);
  }
}

/** Validates the session acknowledgment before capability or possession admission. */
export function parseWorkerSerialHelloAck(frame: WorkerSerialEnvelope, hostNonce: string) {
  const raw = exactSerialRecord(frame.payload, [
    "op",
    "hostNonce",
    "deviceNonce",
    "serialManifest",
    "firmwareSourceCommit",
    "appElfSha256",
    "receiveWindowBytes",
    "receivedBytes",
  ]);
  if (
    frame.kind !== "session" ||
    frame.sequence !== 0 ||
    !frame.sessionId ||
    raw.op !== "hello_ack" ||
    raw.hostNonce !== hostNonce ||
    raw.receiveWindowBytes !== 2048 || raw.receivedBytes !== 0 ||
    !serialNonce(raw.deviceNonce) ||
    typeof raw.firmwareSourceCommit !== "string" ||
    !/^[0-9a-f]{40}$/u.test(raw.firmwareSourceCommit) ||
    typeof raw.appElfSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(raw.appElfSha256)
  )
    throw serialFailure("hello_ack");
  const manifest = parseWorkerSerialManifest(raw.serialManifest);
  const ack = {
    sessionId: frame.sessionId,
    hostNonce,
    deviceNonce: raw.deviceNonce,
    firmwareSourceCommit: raw.firmwareSourceCommit,
    appElfSha256: raw.appElfSha256,
  };
  return { ack: ack satisfies Ack, manifest };
}
