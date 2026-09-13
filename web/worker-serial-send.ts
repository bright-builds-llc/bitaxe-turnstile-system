import { WORKER_SERIAL_PROFILE, serialFailure, type WorkerSerialEnvelope } from "./worker-serial";
import type { WorkerSerialChannel } from "./webserial-worker-port";

/** Precede a large control record with a heartbeat without using receipt credit as authority. */
export async function sendWorkerSerialControl(operations: {
  maybeChannel: WorkerSerialChannel | undefined; maybeSessionId: string | undefined;
  heartbeatAdmitted: boolean; suppressed: boolean; heartbeat(): Promise<void>;
}, kind: WorkerSerialEnvelope["kind"], payload: Record<string, unknown>) {
  const { maybeChannel, maybeSessionId } = operations;
  if (!maybeChannel || !maybeSessionId) throw serialFailure("channel_missing");
  if (kind === "control" && operations.heartbeatAdmitted && !operations.suppressed &&
      new TextEncoder().encode(JSON.stringify(payload)).length > 1024) await operations.heartbeat();
  await maybeChannel.send({ profile: WORKER_SERIAL_PROFILE, kind, sessionId: maybeSessionId, sequence: 1, payload });
}
