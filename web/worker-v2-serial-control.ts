import { serialFailure } from "./worker-serial";
import { noiseAttemptId } from "./worker-noise-diagnostic-values";
import { WorkerV2SerialHistory } from "./worker-v2-serial-history";
import { parseWorkerV2ChannelStart, parseWorkerV2Status, type ChannelStart, type V2Scope, type V2Status } from "./worker-v2-serial";

/** One exact-pair scoped command seam. Status cannot mint or extend work authority. */
export class WorkerV2SerialControl {
  readonly #history = new WorkerV2SerialHistory();
  #startConsumed = false;
  #fenced = false;
  #maybeBound: { attemptId: string; binding: string } | undefined;
  #maybeIdle: { status: V2Status; binding: string } | undefined;
  constructor(readonly operations: {
    requireScope(scope: V2Scope, effect: boolean): void;
    maybeBinding(): string | undefined; possessionFresh(): boolean;
    request(command: string, payload: object): Promise<unknown>;
  }) {}
  get fenced() { return this.#fenced; }
  #check(scope: V2Scope, binding: string, fresh: boolean, effect = false) {
    this.operations.requireScope(scope, effect);
    if (!binding || this.operations.maybeBinding() !== binding || (fresh && !this.operations.possessionFresh())) throw serialFailure("v2_possession");
  }
  async #request(scope: V2Scope, command: string, payload: object, binding: string, fresh: boolean): Promise<V2Status> {
    this.#check(scope, binding, fresh);
    const result = parseWorkerV2Status(await this.operations.request(command, payload));
    this.#check(scope, binding, false);
    if (result.scope !== scope) throw serialFailure("v2_scope_mismatch");
    return result;
  }
  /** Called before a funded Start write, so ambiguous replies never allow another admission. */
  admitShare(attemptId: string, binding: string) {
    this.#check("share", binding, true, true); noiseAttemptId(attemptId);
    if (this.#startConsumed || this.#fenced) throw serialFailure("v2_start_consumed");
    const maybeIdle = this.#maybeIdle;
    if (!maybeIdle || maybeIdle.binding !== binding || maybeIdle.status.scope !== "share" || !maybeIdle.status.observation.wifiConnected || maybeIdle.status.observation.stationIpv4 === null) throw serialFailure("v2_share_network_admission");
    this.#startConsumed = true; this.#maybeBound = { attemptId, binding }; this.#maybeIdle = undefined;
  }
  /** A confirmed funded Start owns resources before its first diagnostic poll. */
  shareActivated(): void {
    if (!this.#startConsumed || !this.#maybeBound) throw serialFailure("v2_share_admission_missing");
    this.#fenced = true;
  }
  async start(input: ChannelStart, binding: string): Promise<V2Status> {
    const payload = parseWorkerV2ChannelStart(input);
    this.#check("channel", binding, true, true);
    const maybeIdle = this.#maybeIdle;
    if (this.#startConsumed || this.#fenced || !maybeIdle || maybeIdle.binding !== binding || !maybeIdle.status.observation.wifiConnected || maybeIdle.status.observation.stationIpv4 === null || payload.expectedBootOrdinal !== maybeIdle.status.observation.bootOrdinal || payload.networkObservedAtUs !== maybeIdle.status.observation.observedAtUs) throw serialFailure("v2_start_admission");
    this.#startConsumed = true; this.#fenced = true; this.#maybeBound = { attemptId: payload.attemptId, binding }; this.#maybeIdle = undefined;
    const result = await this.#request("channel", "stratum_v2_channel_start", payload, binding, true);
    if (result.state !== "admitted" || result.record?.bootOrdinal !== payload.expectedBootOrdinal || result.record.workerGeneration !== maybeIdle.status.observation.workerGeneration || result.record.serialTransportEpoch !== maybeIdle.status.observation.serialTransportEpoch) throw serialFailure("v2_start_correlation");
    this.#observe(result, payload.attemptId, binding);
    return result;
  }
  async status(scope: V2Scope, maybeAttemptId: string | null, binding: string): Promise<V2Status> {
    if (scope !== "channel" && scope !== "share") throw serialFailure("v2_scope");
    if (maybeAttemptId !== null) noiseAttemptId(maybeAttemptId); else this.#maybeIdle = undefined;
    const bound = maybeAttemptId !== null && this.#maybeBound?.attemptId === maybeAttemptId && this.#maybeBound.binding === binding;
    const result = await this.#request(scope, "stratum_v2_status", { schema: "worker-stratum-v2-query-v1", scope, attemptId: maybeAttemptId }, binding, !bound);
    if (maybeAttemptId === null) {
      if (result.state !== "idle" || this.#startConsumed) throw serialFailure("v2_idle_correlation");
      this.#maybeIdle = { status: structuredClone(result), binding };
    } else this.#observe(result, maybeAttemptId, binding);
    return result;
  }
  async cancel(attemptId: string, binding: string): Promise<V2Status> {
    noiseAttemptId(attemptId);
    const bound = this.#maybeBound?.attemptId === attemptId && this.#maybeBound.binding === binding;
    const result = await this.#request("channel", "stratum_v2_channel_cancel", { schema: "worker-stratum-v2-channel-cancel-v1", attemptId }, binding, !bound);
    if (result.state !== "terminal" && !result.record?.firstFailure) throw serialFailure("v2_cancel_postcondition");
    this.#observe(result, attemptId, binding);
    return result;
  }
  #observe(status: V2Status, attemptId: string, binding: string) {
    if (!status.record || status.record.attemptId !== attemptId) throw serialFailure("v2_attempt_correlation");
    this.#history.observe(status); this.#startConsumed = true;
    this.#fenced = status.record.resources.fenceRetained || !status.record.resources.socketClosed || !status.record.resources.workerQuiescent;
    this.#maybeBound = { attemptId, binding };
  }
}
