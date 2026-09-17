import { canonicalJson } from "./headless-values";
import { serialFailure } from "./worker-serial";
import type { V2Status } from "./worker-v2-serial.types";
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const fail = () => { throw serialFailure("v2_retained_evidence"); };
/** A scoped attempt's original binding and facts survive reconnect, never a new admission. */
export class WorkerV2SerialHistory {
  #maybePrevious: V2Status | undefined;
  observe(status: V2Status): void {
    const maybePrevious = this.#maybePrevious;
    if (!status.record) { if (maybePrevious?.record) fail(); return; }
    const after = status.record;
    if (maybePrevious?.record) {
      const before = maybePrevious.record;
      for (const key of ["scope", "attemptId", "bootOrdinal", "workerGeneration", "serialTransportEpoch", "admittedAtDeviceUs", "observationDeadlineDeviceUs"] as const) if (before[key] !== after[key]) fail();
      for (const key of ["poolSessionGeneration", "poolTransportEpoch", "jobCommitment", "firstFailure", "terminalAtDeviceUs", "outcome", "authorityDeadlineDeviceUs"] as const) if (before[key] !== null && !same(before[key], after[key])) fail();
      if ((before.scope === "channel" || before.outcome !== null) && before.authorityDeadlineDeviceUs !== after.authorityDeadlineDeviceUs) fail();
      if (maybePrevious.connection !== null && !same(maybePrevious.connection, status.connection)) fail();
      if (["admitted", "running", "terminal"].indexOf(after.state) < ["admitted", "running", "terminal"].indexOf(before.state)) fail();
      if (after.events.length < before.events.length || after.secondaryFailures.length < before.secondaryFailures.length || after.shareFacts.length < before.shareFacts.length) fail();
      before.events.forEach((event, i) => { if (!same(event, after.events[i])) fail(); });
      before.secondaryFailures.forEach((event, i) => { if (!same(event, after.secondaryFailures[i])) fail(); });
      if ((before.outcome || before.firstFailure) && after.events.slice(before.events.length).some(e => !["socket_closed", "worker_quiescent", "revoked", "shutdown", "cooled", "accepted"].includes(e.kind))) fail();
      for (const key of ["socketClosed", "workerQuiescent"] as const) if (before.resources[key] && !after.resources[key]) fail();
      for (const key of ["socketClosedAtUs", "workerQuiescentAtUs"] as const) if (before.resources[key] !== null && before.resources[key] !== after.resources[key]) fail();
      if (!before.resources.fenceRetained && after.resources.fenceRetained) fail();
      before.timings.forEach(t => {
        const maybeNext = after.timings.find(next => next.operation === t.operation);
        if (!maybeNext || maybeNext.count < t.count || maybeNext.failedCount < t.failedCount || (t.firstStartedAtDeviceUs !== null && t.firstStartedAtDeviceUs !== maybeNext.firstStartedAtDeviceUs)) fail();
        if (maybeNext && ["maxDurationUs", "totalDurationUs", "lastFinishedAtDeviceUs"].some(key => {
          const k = key as "maxDurationUs" | "totalDurationUs" | "lastFinishedAtDeviceUs";
          return t[k] !== null && maybeNext[k] !== null && maybeNext[k]! < t[k]!;
        })) fail();
      });
      before.shareFacts.forEach((fact, i) => {
        const next = after.shareFacts[i]; if (!next) return fail();
        for (const [key, value] of Object.entries(fact)) if (value !== null && !same(value, next[key as keyof typeof next])) fail();
      });
      if ((before.outcome || before.firstFailure) && after.shareFacts.length !== before.shareFacts.length) fail();
    }
    this.#maybePrevious = structuredClone(status);
  }
}
