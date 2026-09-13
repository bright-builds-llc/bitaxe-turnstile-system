import type { WorkerCadenceSummary, WorkerCadenceReview } from "./worker-telemetry-cadence";

export function cadenceFixture(): WorkerCadenceReview {
  const summary = (phase: WorkerCadenceSummary["phase"]): WorkerCadenceSummary => ({
    maxProbeCount: phase === "usb" ? 12 : 0, firstMaxProbeAtUs: phase === "usb" ? 1000 : 0, lastMaxProbeAtUs: phase === "usb" ? 55_001_000 : 0,
    phase, state: "complete", generation: 7, armedAtUs: 100, startedAtUs: 500,
    endedAtUs: 60_501_000, intervalCount: 120, intervalBuckets: [0, 120, 0, 0],
    maximumIntervalUs: 501000, maximumExecutionUs: 1000, maximumLiveUs: 800,
    maximumLogsUs: 100, maximumPruneUs: 100, cpuMismatchCount: 0, priorityMismatchCount: 0,
    subscriberMismatchCount: 0, projectionCount: 120, unchangedCount: 0, noSubscriberCount: 0,
    projectionFailures: 0, serializationFailures: 0, queueFailures: 0, sendFailures: 0,
    sendsQueued: 120, sendsCompleted: 120, pendingSends: 0, clockFailures: 0, overflow: false, passed: true,
  });
  return { schema: "worker-telemetry-cadence-v1", snapshotAvailable: true, droppedObservations: 0, storageBytes: 1000,
    phases: [summary("idle"), summary("usb"), summary("mining")] };
}
