import {
  createClockDiscontinuityNonce, parseAuthorizationRejectionReview, parseClockDiscontinuityStimulusAck, parseClockDiscontinuityStimulusReview,
  type AuthorizationRejectionReview, type ClockDiscontinuityStimulusAck, type ClockDiscontinuityStimulusReview,
} from "./worker-restoration-qualification";
import { serialFailure } from "./worker-serial";

/**
 * Restoration-qualification commands over the admitted serial session. The stimulus needs the explicit hook
 * flag and an active lease; both reviews are read-only and take a fresh idle possession proof first.
 */
export class WorkerRestorationControl {
  #renewalsStopped = false;
  constructor(readonly operations: {
    stimulusAllowed(): boolean;
    qualification(): boolean;
    requireIdleChannel(): void;
    activeLease(): boolean;
    prove(): Promise<unknown>;
    request(command: string, maybePayload?: object): Promise<unknown>;
  }) {}
  /** After a stimulus request leaves the browser, the lease it targets is never renewed. */
  get renewalsStopped(): boolean { return this.#renewalsStopped; }
  leaseStarted(): void { this.#renewalsStopped = false; }
  async stimulus(): Promise<ClockDiscontinuityStimulusAck> {
    this.operations.requireIdleChannel();
    if (!this.operations.stimulusAllowed() || !this.operations.activeLease() || this.#renewalsStopped) throw serialFailure("probe_admission");
    const requestNonce = createClockDiscontinuityNonce();
    this.#renewalsStopped = true;
    return parseClockDiscontinuityStimulusAck(await this.operations.request("clock_discontinuity_stimulus", { requestNonce }), requestNonce);
  }
  async stimulusReview(): Promise<ClockDiscontinuityStimulusReview> {
    return parseClockDiscontinuityStimulusReview(await this.#review("clock_discontinuity_stimulus_review"));
  }
  async rejectionReview(): Promise<AuthorizationRejectionReview> {
    return parseAuthorizationRejectionReview(await this.#review("authorization_rejection_review"));
  }
  async #review(command: string): Promise<unknown> {
    this.#requireIdle();
    await this.operations.prove();
    this.#requireIdle();
    return this.operations.request(command);
  }
  #requireIdle(): void {
    this.operations.requireIdleChannel();
    if (!this.operations.qualification() || this.operations.activeLease()) throw serialFailure("probe_admission");
  }
}
