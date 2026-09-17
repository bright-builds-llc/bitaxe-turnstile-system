import type { WorkerControllerStatus } from "./worker-controller";
/** Drain an existing renewal before the fault. Host elapsed time grants no device authority. */
export async function drainWorkerAcceptancePoll(polling: () => boolean): Promise<void> {
  const deadline = performance.now() + 2000;
  while (polling()) {
    if (performance.now() >= deadline) throw new Error("qualification_poll_busy");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
/** Both native deadlines must leave room for the independent heartbeat stop. */
export type WorkerV2FaultHeadroom = {
  schema: "worker-v2-fault-headroom-v1"; workerGeneration: number;
  headroomObservedAtDeviceUs: number; leaseRemainingMs: number; workGateRemainingMs: number;
};
export function requireWorkerV2FaultHeadroom(fresh: WorkerControllerStatus): WorkerV2FaultHeadroom {
  if (fresh.state !== "mining" || !fresh.qualification || fresh.qualification.revocation_reason !== "none" || fresh.qualification.safe_stop_complete || fresh.lease.expiresAtMonotonicMilliseconds - fresh.monotonicMilliseconds < 5000 || (fresh.qualification.work_gate_remaining_ms ?? 0) < 5000) throw new Error("v2_fault_headroom");
  const observedAtUs = fresh.monotonicMilliseconds * 1000;
  if (!Number.isSafeInteger(observedAtUs) || fresh.qualification.work_gate_remaining_ms === null) throw new Error("v2_fault_headroom");
  return { schema: "worker-v2-fault-headroom-v1", workerGeneration: fresh.qualification.generation,
    headroomObservedAtDeviceUs: observedAtUs, leaseRemainingMs: fresh.lease.expiresAtMonotonicMilliseconds - fresh.monotonicMilliseconds,
    workGateRemainingMs: fresh.qualification.work_gate_remaining_ms };
}
/** Capture and act on the same fresh device response; callers own application serialization. */
export async function captureWorkerV2HeartbeatFault(operations: {
  status(): Promise<WorkerControllerStatus>; observe(status: WorkerControllerStatus): void; suppress(): void;
}): Promise<WorkerV2FaultHeadroom> {
  const status = await operations.status(), headroom = requireWorkerV2FaultHeadroom(status);
  operations.observe(status); operations.suppress(); return headroom;
}

/** Share status reads and timer renewal use one application slot; heartbeat I/O stays independent. */
export async function serializeWorkerAcceptanceRead<T>(operations: {
  polling(): boolean; claim(value: boolean): void; run(): Promise<T>;
}): Promise<T> {
  const deadline = performance.now() + 2000;
  while (operations.polling()) {
    if (performance.now() >= deadline) throw new Error("qualification_poll_busy");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  // No await separates the last predicate check and acquisition.
  operations.claim(true);
  try { return await operations.run(); } finally { operations.claim(false); }
}
