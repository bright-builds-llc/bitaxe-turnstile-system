import { WORKER_CONTROLLER_PROTOCOL_VERSION } from "./worker-controller";
import { exactSerialRecord, serialFailure } from "./worker-serial";

/** Computes the largest safe all-x round trip from both exact Controller envelope sizes. */
export async function probeWorkerSerialTransport(
  requestId: string,
  maybePaddingBytes: number | undefined,
  request: (padding: string) => Promise<unknown>,
) {
  const size = (value: unknown) =>
    new TextEncoder().encode(JSON.stringify(value)).length;
  const requestOverhead = size({
    protocolVersion: WORKER_CONTROLLER_PROTOCOL_VERSION,
    requestId,
    command: "transport_probe",
    payload: { padding: "" },
  });
  const responseOverhead = size({
    protocolVersion: WORKER_CONTROLLER_PROTOCOL_VERSION,
    requestId,
    ok: true,
    result: { padding: "" },
  });
  const maximum = 65536 - Math.max(requestOverhead, responseOverhead);
  const paddingBytes = maybePaddingBytes ?? maximum;
  if (
    !Number.isSafeInteger(paddingBytes) ||
    paddingBytes < 0 ||
    paddingBytes > maximum
  )
    throw serialFailure("probe_bound");
  const padding = "x".repeat(paddingBytes);
  const result = exactSerialRecord(await request(padding), ["padding"]);
  if (result.padding !== padding) throw serialFailure("probe_mismatch");
  return {
    paddingBytes,
    requestPayloadBytes: requestOverhead + paddingBytes,
    responsePayloadBytes: responseOverhead + paddingBytes,
  };
}
