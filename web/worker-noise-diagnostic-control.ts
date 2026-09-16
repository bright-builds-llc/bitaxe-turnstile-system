import { WorkerNoiseDiagnosticHistory } from "./worker-noise-diagnostic-history";
import { canonicalJson } from "./headless-values";
import { serialFailure } from "./worker-serial";
import { noiseAttemptId } from "./worker-noise-diagnostic-values";
import { parseNoiseStartInput, parseNoiseStatus, type NoiseStartInput, type NoiseStatus } from "./worker-noise-diagnostic";

/** Private bounded command seam; no implicit proof renewal, retries, or signing authority. */
export class WorkerNoiseDiagnosticControl {
  readonly #history = new WorkerNoiseDiagnosticHistory();
  #cleanupBlocked = false;
  #startConsumed = false;
  #fenced = false;
  #maybeLive: { attemptId: string; binding: string } | undefined;
  #maybeIdle: { status: NoiseStatus; binding: string } | undefined;
  constructor(readonly operations: {
    requireIdle(): void; maybeBinding(): string | undefined; possessionFresh(): boolean;
    request(command: string, payload: object): Promise<unknown>;
  }) {}
  get fenced(): boolean { return this.#fenced; }
  #check(binding: string, fresh: boolean): void {
    this.operations.requireIdle();
    if (!binding || this.operations.maybeBinding() !== binding || (fresh && !this.operations.possessionFresh())) throw serialFailure("noise_possession");
  }
  async #request(command: string, payload: object, binding: string, fresh: boolean): Promise<NoiseStatus> {
    this.#check(binding, fresh);
    const result = await this.operations.request(command, payload);
    this.#check(binding, false);
    return parseNoiseStatus(result);
  }
  async start(input: NoiseStartInput, expectedBinding: string): Promise<NoiseStatus> {
    const payload = parseNoiseStartInput(input);
    this.#check(expectedBinding, true);
    const maybeIdle = this.#maybeIdle;
    if (this.#startConsumed || this.#fenced || !maybeIdle || maybeIdle.binding !== expectedBinding || !maybeIdle.status.observation.wifiConnected || maybeIdle.status.observation.stationIpv4 === null || maybeIdle.status.observation.bootOrdinal !== payload.expectedBootOrdinal || maybeIdle.status.observation.observedAtUs !== payload.networkObservedAtUs) throw serialFailure("noise_admission");
    // The local slot survives an ambiguous write/reply. Only retained review may settle cleanup.
    this.#startConsumed = true;
    this.#fenced = true;
    this.#maybeIdle = undefined;
    this.#maybeLive = { attemptId: payload.attemptId, binding: expectedBinding };
    const inputBytes = new TextEncoder().encode(canonicalJson(payload));
    const hash = await crypto.subtle.digest("SHA-256", inputBytes);
    const digest = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
    const result = await this.#request("noise_diagnostic_start", payload, expectedBinding, true);
    if (result.state !== "admitted" || !result.job || result.job.attemptId !== payload.attemptId || result.job.inputSha256 !== digest || result.job.bootOrdinal !== payload.expectedBootOrdinal || result.job.workerGeneration !== maybeIdle.status.observation.workerGeneration || result.job.transportEpoch !== maybeIdle.status.observation.transportEpoch) throw serialFailure("noise_correlation");
    this.#history.observe(result.job);
    return result;
  }
  async status(maybeAttemptId: string | null, expectedBinding: string): Promise<NoiseStatus> {
    if (maybeAttemptId !== null) noiseAttemptId(maybeAttemptId);
    else this.#maybeIdle = undefined;
    const live = maybeAttemptId !== null && this.#maybeLive?.attemptId === maybeAttemptId && this.#maybeLive.binding === expectedBinding;
    const result = await this.#request("noise_diagnostic_status", { schema: "worker-noise-diagnostic-query-v1", attemptId: maybeAttemptId }, expectedBinding, !live);
    if (maybeAttemptId === null) {
      if (result.state !== "idle") throw serialFailure("noise_correlation");
      this.#maybeIdle = { status: structuredClone(result), binding: expectedBinding };
    } else this.#observe(result, maybeAttemptId, expectedBinding);
    return result;
  }
  async cancel(attemptId: string, expectedBinding: string): Promise<NoiseStatus> {
    noiseAttemptId(attemptId);
    const live = this.#maybeLive?.attemptId === attemptId && this.#maybeLive.binding === expectedBinding;
    const result = await this.#request("noise_diagnostic_cancel", { schema: "worker-noise-diagnostic-query-v1", attemptId }, expectedBinding, !live);
    if (!["cancelling", "terminal"].includes(result.state)) throw serialFailure("noise_cancel_postcondition");
    this.#observe(result, attemptId, expectedBinding);
    return result;
  }
  #observe(status: NoiseStatus, attemptId: string, binding: string): void {
    if (!status.job || status.job.attemptId !== attemptId) throw serialFailure("noise_correlation");
    this.#history.observe(status.job);
    this.#startConsumed = true;
    const resources = status.job.resources;
    this.#cleanupBlocked ||= status.job.terminal?.outcome === "incomplete" || resources.deadlineMet === false;
    this.#fenced = this.#cleanupBlocked || status.state !== "terminal" || resources.socketState === "open" || resources.workerState === "running" || !resources.volatileInputsDisposed;
    if (status.state !== "terminal") this.#maybeLive = { attemptId, binding };
    else this.#maybeLive = undefined;
  }
}
