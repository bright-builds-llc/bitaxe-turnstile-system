import { exactSerialRecord, parseWorkerSerialManifest, serialNonce, serialFailure, type WorkerSerialEnvelope } from "./worker-serial";
import type { Ack } from "./worker-serial-controller.types";

/** Validates the session acknowledgment before capability or possession admission. */
export function parseWorkerSerialHelloAck(frame: WorkerSerialEnvelope, hostNonce: string) {
  const raw = exactSerialRecord(frame.payload, [
    "op",
    "hostNonce",
    "deviceNonce",
    "serialManifest",
    "firmwareSourceCommit",
    "appElfSha256",
  ]);
  if (
    frame.kind !== "session" ||
    frame.sequence !== 0 ||
    !frame.sessionId ||
    raw.op !== "hello_ack" ||
    raw.hostNonce !== hostNonce ||
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
