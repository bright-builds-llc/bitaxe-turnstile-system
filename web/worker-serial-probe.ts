import { WORKER_CONTROLLER_PROTOCOL_VERSION } from "./worker-controller";
import { exactSerialRecord, serialFailure } from "./worker-serial";

/** Exercises both exact Controller payload bounds with fixed-pattern request/response bytes. */
export async function probeWorkerSerialTransport(
  requestId: string,
  maybePaddingBytes: number | undefined,
  request: (payload: { padding: string; responsePaddingBytes: number }) => Promise<unknown>,
) {
  const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
  const requestOverheadFor = (responsePaddingBytes: number) => size({
    protocolVersion: WORKER_CONTROLLER_PROTOCOL_VERSION, requestId, command: "transport_probe",
    payload: { padding: "", responsePaddingBytes },
  });
  // Maximum-size counts are five digits in both directions; include the received count.
  const paddingBytes = maybePaddingBytes ?? 65536 - requestOverheadFor(65536);
  const responseOverhead = size({
    protocolVersion: WORKER_CONTROLLER_PROTOCOL_VERSION, requestId, ok: true,
    result: { padding: "", requestPaddingBytes: paddingBytes },
  });
  const responsePaddingBytes = maybePaddingBytes ?? 65536 - responseOverhead;
  const requestOverhead = requestOverheadFor(responsePaddingBytes);
  const maximum = 65536 - requestOverhead;
  if (!Number.isSafeInteger(paddingBytes) || paddingBytes < 0 || paddingBytes > maximum ||
    responsePaddingBytes < paddingBytes || responsePaddingBytes + responseOverhead > 65536) {
    throw serialFailure("probe_bound");
  }
  const result = exactSerialRecord(await request({ padding: "x".repeat(paddingBytes), responsePaddingBytes }), ["padding", "requestPaddingBytes"]);
  if (result.requestPaddingBytes !== paddingBytes || result.padding !== "x".repeat(responsePaddingBytes)) throw serialFailure("probe_mismatch");
  return { paddingBytes, requestPayloadBytes: requestOverhead + paddingBytes, responsePayloadBytes: responseOverhead + responsePaddingBytes };
}
