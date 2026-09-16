import { WorkerNoiseDiagnosticHistory } from "./worker-noise-diagnostic-history";
import { canonicalJson } from "./headless-values";
import { serialFailure } from "./worker-serial";
import { noiseAttemptId } from "./worker-noise-diagnostic-values";
import { parseNoiseStartInput, parseNoiseStatus, parseNoiseStartInputV2, parseNoiseStatusV2, type NoiseStartInputAny, type NoiseStatusAny, type NoiseVersion } from "./worker-noise-diagnostic";

/** Private bounded command seam; no implicit proof renewal, retries, or signing authority. */
export class WorkerNoiseDiagnosticControl {
  readonly #history = new WorkerNoiseDiagnosticHistory();
  #cleanupBlocked = false;
  #startConsumed = false;
  #fenced = false;
  #maybeBoundJob: { attemptId: string; binding: string } | undefined;
  #maybeIdle: { status: NoiseStatusAny; binding: string } | undefined;
  constructor(readonly operations: {
    requireIdle(): void; maybeBinding(): string | undefined; possessionFresh(): boolean;
    request(command: string, payload: object): Promise<unknown>;
  }, readonly version: NoiseVersion) {
    if (version !== "v1" && version !== "v2") throw serialFailure("noise_schema");
  }
  get fenced(): boolean { return this.#fenced; }
  #check(binding: string, fresh: boolean): void {
    this.operations.requireIdle();
    if (!binding || this.operations.maybeBinding() !== binding || (fresh && !this.operations.possessionFresh())) throw serialFailure("noise_possession");
  }
  async #request(command: string, payload: object, binding: string, fresh: boolean): Promise<NoiseStatusAny> {
    this.#check(binding, fresh);
    const result = await this.operations.request(command, payload);
    this.#check(binding, false);
    return this.version === "v2" ? parseNoiseStatusV2(result) : parseNoiseStatus(result);
  }
  async start(input: NoiseStartInputAny, expectedBinding: string): Promise<NoiseStatusAny> {
    const payload = this.version === "v2" ? parseNoiseStartInputV2(input) : parseNoiseStartInput(input);
    this.#check(expectedBinding, true);
    const maybeIdle = this.#maybeIdle;
    if (this.#startConsumed || this.#fenced || !maybeIdle || maybeIdle.binding !== expectedBinding || !maybeIdle.status.observation.wifiConnected || maybeIdle.status.observation.stationIpv4 === null || maybeIdle.status.observation.bootOrdinal !== payload.expectedBootOrdinal || maybeIdle.status.observation.observedAtUs !== payload.networkObservedAtUs) throw serialFailure("noise_admission");
    // The local slot survives an ambiguous write/reply. Only retained review may settle cleanup.
    this.#startConsumed = true;
    this.#fenced = true;
    this.#maybeIdle = undefined;
    this.#maybeBoundJob = { attemptId: payload.attemptId, binding: expectedBinding };
    const inputBytes = new TextEncoder().encode(canonicalJson(payload));
    const hash = await crypto.subtle.digest("SHA-256", inputBytes);
    const digest = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
    const result = await this.#request("noise_diagnostic_start", payload, expectedBinding, true);
    if (result.state !== "admitted" || !result.job || result.job.attemptId !== payload.attemptId || result.job.inputSha256 !== digest || result.job.bootOrdinal !== payload.expectedBootOrdinal || result.job.workerGeneration !== maybeIdle.status.observation.workerGeneration || result.job.transportEpoch !== maybeIdle.status.observation.transportEpoch) throw serialFailure("noise_correlation");
    this.#history.observe(result.job);
    return result;
  }
  async status(maybeAttemptId: string | null, expectedBinding: string): Promise<NoiseStatusAny> {
    if (maybeAttemptId !== null) noiseAttemptId(maybeAttemptId);
    else this.#maybeIdle = undefined;
    const admittedBinding = maybeAttemptId !== null && this.#maybeBoundJob?.attemptId === maybeAttemptId && this.#maybeBoundJob.binding === expectedBinding;
    const result = await this.#request("noise_diagnostic_status", { schema: "worker-noise-diagnostic-query-v1", attemptId: maybeAttemptId }, expectedBinding, !admittedBinding);
    if (maybeAttemptId === null) {
      if (result.state !== "idle") throw serialFailure("noise_correlation");
      this.#maybeIdle = { status: structuredClone(result), binding: expectedBinding };
    } else this.#observe(result, maybeAttemptId, expectedBinding);
    return result;
  }
  async cancel(attemptId: string, expectedBinding: string): Promise<NoiseStatusAny> {
    noiseAttemptId(attemptId);
    const admittedBinding = this.#maybeBoundJob?.attemptId === attemptId && this.#maybeBoundJob.binding === expectedBinding;
    const result = await this.#request("noise_diagnostic_cancel", { schema: "worker-noise-diagnostic-query-v1", attemptId }, expectedBinding, !admittedBinding);
    if (!["cancelling", "terminal"].includes(result.state)) throw serialFailure("noise_cancel_postcondition");
    this.#observe(result, attemptId, expectedBinding);
    return result;
  }
  #observe(status: NoiseStatusAny, attemptId: string, binding: string): void {
    if (!status.job || status.job.attemptId !== attemptId) throw serialFailure("noise_correlation");
    this.#history.observe(status.job);
    this.#startConsumed = true;
    const resources = status.job.resources;
    this.#cleanupBlocked ||= this.version === "v1" && (status.job.terminal?.outcome === "incomplete" || resources.deadlineMet === false);
    this.#fenced = this.#cleanupBlocked || status.state !== "terminal" || resources.socketState === "open" || resources.workerState === "running" || !resources.volatileInputsDisposed;
    if (status.state !== "terminal") this.#maybeBoundJob = { attemptId, binding };
  }
}
