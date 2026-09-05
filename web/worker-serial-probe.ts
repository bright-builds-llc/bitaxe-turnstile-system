import { WORKER_CONTROLLER_PROTOCOL_VERSION } from "./worker-controller";
import { exactSerialRecord, serialFailure } from "./worker-serial";

/** Exercises both exact Controller payload bounds with fixed-pattern request/response bytes. */
export async function probeWorkerSerialTransport(
  requestId: string,
  maybePaddingBytes: number | undefined,
  request: (payload: { padding: string; responsePaddingBytes: number }) => Promise<unknown>,
) {
  const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
  const responseOverhead = size({
    protocolVersion: WORKER_CONTROLLER_PROTOCOL_VERSION, requestId, ok: true, result: { padding: "" },
  });
  const responsePaddingBytes = maybePaddingBytes ?? 65536 - responseOverhead;
  const requestOverhead = size({
    protocolVersion: WORKER_CONTROLLER_PROTOCOL_VERSION, requestId, command: "transport_probe",
    payload: { padding: "", responsePaddingBytes },
  });
  const maximum = 65536 - requestOverhead;
  const paddingBytes = maybePaddingBytes ?? maximum;
  if (!Number.isSafeInteger(paddingBytes) || paddingBytes < 0 || paddingBytes > maximum ||
    responsePaddingBytes < paddingBytes || responsePaddingBytes + responseOverhead > 65536) {
    throw serialFailure("probe_bound");
  }
  const result = exactSerialRecord(await request({ padding: "x".repeat(paddingBytes), responsePaddingBytes }), ["padding"]);
  if (result.padding !== "x".repeat(responsePaddingBytes)) throw serialFailure("probe_mismatch");
  return { paddingBytes, requestPayloadBytes: requestOverhead + paddingBytes, responsePayloadBytes: responseOverhead + responsePaddingBytes };
}
