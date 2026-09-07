import { exactSerialRecord, parseWorkerSerialManifest, serialNonce, serialFailure, type WorkerSerialEnvelope } from "./worker-serial";
import type { Ack } from "./worker-serial-controller.types";

/** Native output from a retired session grants no authority during a fresh Hello. */
export class WorkerSerialHelloCredits {
  #ignored = 0;
  ignore(frame: WorkerSerialEnvelope): boolean {
    if (frame.kind !== "session" || frame.payload.op !== "receive_credit") return false;
    const credit = exactSerialRecord(frame.payload, ["op", "receivedBytes"]);
    if (!frame.sessionId || frame.sequence === 0 || !Number.isSafeInteger(credit.receivedBytes) ||
      Number(credit.receivedBytes) <= 0 || Number(credit.receivedBytes) > 0xffffffff || ++this.#ignored > 32)
      throw serialFailure("credit_invalid");
    return true;
  }
}

type HelloAdmission = ReturnType<typeof parseWorkerSerialHelloAck>;

/** Atomically validates Hello, installs the peer, then ends bootstrap before waking callers. */
export class WorkerSerialHelloExchange {
  readonly result: Promise<HelloAdmission>;
  readonly #credits = new WorkerSerialHelloCredits();
  #maybeWaiting: { resolve(value: HelloAdmission): void; reject(error: Error): void } | undefined;

  constructor(
    private readonly validate: (frame: WorkerSerialEnvelope) => HelloAdmission,
    private readonly admitted: (value: HelloAdmission) => void,
  ) {
    this.result = new Promise((resolve, reject) => { this.#maybeWaiting = { resolve, reject }; });
  }

  receive(frame: WorkerSerialEnvelope): boolean {
    const pending = this.#maybeWaiting;
    if (!pending) return false;
    if (this.#credits.ignore(frame)) return true;
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
