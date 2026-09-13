import { parseWorkerCadenceArm, parseWorkerCadencePhase, parseWorkerCadenceReview, parseWorkerTelemetryEndpoint, type WorkerCadencePhase } from "./worker-telemetry-cadence";
import { serialFailure } from "./worker-serial";

/** All cadence commands take a fresh idle possession proof without creating work authority. */
export class WorkerTelemetryCadenceControl {
  constructor(readonly operations: {
    requireIdle(): void; prove(): Promise<unknown>;
    request(command: string, payload: object): Promise<unknown>;
    maybeBinding(): string | undefined;
    possessionFresh(): boolean;
  }) {}
  async #request(command: string, payload: object, maybeExpectedBinding?: string) {
    this.operations.requireIdle();
    if (maybeExpectedBinding === undefined) await this.operations.prove();
    else if (!this.operations.possessionFresh() || this.operations.maybeBinding() !== maybeExpectedBinding) throw serialFailure("probe_admission");
    this.operations.requireIdle();
    if (!this.operations.maybeBinding()) throw serialFailure("probe_admission");
    return this.operations.request(command, payload);
  }
  async arm(phase: WorkerCadencePhase) {
    const admitted = parseWorkerCadencePhase(phase);
    const result = parseWorkerCadenceArm(await this.#request("telemetry_cadence_arm", { phase: admitted }));
    if (result.phase !== admitted) throw serialFailure("correlation");
    return result;
  }
  async review() { return parseWorkerCadenceReview(await this.#request("telemetry_cadence_review", {})); }
  async endpoint(maybeExpectedBinding?: string) {
    const endpoint = parseWorkerTelemetryEndpoint(await this.#request("telemetry_cadence_endpoint", {}, maybeExpectedBinding));
    const maybeBinding = this.operations.maybeBinding();
    if (!maybeBinding || (maybeExpectedBinding !== undefined && maybeBinding !== maybeExpectedBinding)) throw serialFailure("probe_admission");
    return { ...endpoint, controlSessionBindingSha256: maybeBinding };
  }
}
