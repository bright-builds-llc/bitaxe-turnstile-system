import { WorkerV2SerialHistory } from "./worker-v2-serial-history";
import type { ChannelStart, V2Scope, V2Status } from "./worker-v2-serial";
import type { WebSerialWorkerController } from "./webserial-worker-controller";
import type { WorkerPreservationContinuity } from "./worker-preservation";
/** Private page memory survives this scope's updates; no imported baseline or cross-scope handoff. */
export function createWorkerV2PageOperations(operations: {
  serializeRead<T>(run: () => Promise<T>): Promise<T>;
  changed(): void; phase(): "before" | "candidate" | undefined; scope(): V2Scope | undefined;
  connected(): boolean; idle(): boolean;
  controller(): Pick<WebSerialWorkerController, "prepareWorkerLeaseAuthorizationContext" | "stratumV2ChannelStart" | "stratumV2Status" | "stratumV2ChannelCancel" | "telemetryCadenceEndpoint">;
  maybeReviewedBinding(): string | undefined;
  maybePreservation(): WorkerPreservationContinuity | undefined;
}) {
  const history = new WorkerV2SerialHistory(); let consumed = false;
  const requireCandidate = () => { if (!operations.connected() || operations.phase() !== "candidate") throw new Error("v2_page_admission"); };
  const requireChannel = () => { requireCandidate(); if (operations.scope() !== "channel" || !operations.idle()) throw new Error("v2_channel_admission"); };
  const observe = (status: V2Status) => { history.observe(status); return status; };
  return {
    async stratumV2Possession() {
      requireCandidate(); if (!operations.idle()) throw new Error("v2_possession_idle_required");
      const context = await operations.controller().prepareWorkerLeaseAuthorizationContext("start");
      requireCandidate(); return context.controlSessionBindingSha256;
    },
    async stratumV2TelemetryEndpoint(maybeBinding?: string) {
      requireCandidate();
      const binding = maybeBinding ?? operations.maybeReviewedBinding();
      if (typeof binding !== "string" || !binding) throw new Error("v2_observer_possession_required");
      if (operations.scope() !== "share" || !operations.idle()) throw new Error("v2_observer_admission");
      return operations.serializeRead(async () => {
        requireCandidate();
        if (!operations.idle()) throw new Error("v2_observer_admission");
        const status = await operations.controller().stratumV2Status("share", null, binding);
        const endpoint = await operations.controller().telemetryCadenceEndpoint(binding);
        const current = status.observation;
        if (endpoint.controlSessionBindingSha256 !== binding || endpoint.bootOrdinal !== current.bootOrdinal || endpoint.generation !== current.workerGeneration || endpoint.ipv4 !== current.stationIpv4 || current.observedAtUs === null || endpoint.observedAtUs < current.observedAtUs || endpoint.observedAtUs - current.observedAtUs > 5000000) throw new Error("v2_observer_binding");
        return endpoint;
      });
    },
    async stratumV2ChannelStart(input: ChannelStart, binding: string) {
      requireChannel(); const maybeBaseline = operations.maybePreservation();
      if (!maybeBaseline || !maybeBaseline.settings_match || !maybeBaseline.device_identity_match || !maybeBaseline.authorization_high_water_match || maybeBaseline.mine_on_boot || consumed) throw new Error("v2_baseline_required");
      consumed = true;
      try { return observe(await operations.controller().stratumV2ChannelStart(input, binding)); } finally { operations.changed(); }
    },
    async stratumV2Status(scope: V2Scope, attemptIdOrNull: string | null, binding: string) {
      requireCandidate(); if (scope !== operations.scope()) throw new Error("v2_scope_mismatch");
      return operations.serializeRead(async () => {
        requireCandidate();
        return observe(await operations.controller().stratumV2Status(scope, attemptIdOrNull, binding));
      });
    },
    async stratumV2ChannelCancel(attemptId: string, binding: string) {
      requireChannel();
      try { return observe(await operations.controller().stratumV2ChannelCancel(attemptId, binding)); } finally { operations.changed(); }
    },
  };
}

/** Page-owned funded Start claim survives controller replacement and an ambiguous reply. */
export class WorkerV2ShareStartClaim {
  #consumed = false;
  consume(): void {
    if (this.#consumed) throw new Error("v2_share_start_consumed");
    this.#consumed = true;
  }
}
