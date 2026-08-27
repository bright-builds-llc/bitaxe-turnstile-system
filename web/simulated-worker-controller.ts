import {
  WORKER_CONTROLLER_PROTOCOL_VERSION,
  type WorkerController,
  type WorkerControllerCapabilities,
  type WorkerControllerStatus,
  type WorkerLeaseGrant,
  type WorkerLeaseRenewal,
  type WorkerRestorationReason,
  parseWorkerControllerCapabilities,
  parseWorkerLeaseGrant,
  parseWorkerLeaseRenewal,
} from "./worker-controller";

type ClockDiscontinuity = "lost_continuity" | "monotonic_reset" | "reboot";
type ClockListener = () => void;

/** Deterministic mutable clock that synchronously notifies the simulator of safety events. */
export class SimulatedWorkerControllerClock {
  #continuityId: string;
  #monotonicMilliseconds: number;
  #wallTimeSeconds: number;
  #maybeDiscontinuity: ClockDiscontinuity | undefined;
  readonly #listeners = new Set<ClockListener>();

  constructor(continuityId: string, monotonicMilliseconds: number, wallTimeSeconds: number) {
    validateContinuityId(continuityId);
    validateClockValue(monotonicMilliseconds, "monotonic time");
    validateClockValue(wallTimeSeconds, "wall time");
    this.#continuityId = continuityId;
    this.#monotonicMilliseconds = monotonicMilliseconds;
    this.#wallTimeSeconds = wallTimeSeconds;
  }

  /** Advances only the monotonic domain and rejects unsafe arithmetic. */
  advanceMonotonic(milliseconds: number): void {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new Error("monotonic advance is invalid");
    }
    const next = this.#monotonicMilliseconds + milliseconds;
    validateClockValue(next, "monotonic time");
    this.#monotonicMilliseconds = next;
    this.#emit();
  }

  /** Changes wall time without affecting lease enforcement. */
  jumpWallTime(seconds: number): void {
    validateClockValue(seconds, "wall time");
    this.#wallTimeSeconds = seconds;
  }

  /** Records an explicit monotonic discontinuity, even when the new value is larger. */
  resetMonotonic(milliseconds: number): void {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new Error("monotonic reset is invalid");
    }
    this.#monotonicMilliseconds = milliseconds;
    this.#maybeDiscontinuity = "monotonic_reset";
    this.#emit();
  }

  /** Records lost boot/control continuity. */
  loseContinuity(nextContinuityId: string): void {
    validateContinuityId(nextContinuityId);
    this.#continuityId = nextContinuityId;
    this.#maybeDiscontinuity = "lost_continuity";
    this.#emit();
  }

  /** Records a reboot and a fresh zero-based monotonic domain. */
  reboot(nextContinuityId: string): void {
    validateContinuityId(nextContinuityId);
    this.#continuityId = nextContinuityId;
    this.#monotonicMilliseconds = 0;
    this.#maybeDiscontinuity = "reboot";
    this.#emit();
  }

  snapshot(): {
    continuityId: string;
    monotonicMilliseconds: number;
    maybeDiscontinuity?: ClockDiscontinuity;
  } {
    return {
      continuityId: this.#continuityId,
      monotonicMilliseconds: this.#monotonicMilliseconds,
      ...(this.#maybeDiscontinuity
        ? { maybeDiscontinuity: this.#maybeDiscontinuity }
        : {}),
    };
  }

  acknowledgeDiscontinuity(): void {
    this.#maybeDiscontinuity = undefined;
  }

  subscribe(listener: ClockListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

type ActiveLease = {
  grant: WorkerLeaseGrant;
  continuityId: string;
  lastMonotonicMilliseconds: number;
  renewAtMonotonicMilliseconds: number;
  expiresAtMonotonicMilliseconds: number;
};

/** Verifies the complete parsed start or renewal input, including all work configuration. */
export type SimulatedWorkerLeaseAuthorizationVerifier = (
  input: WorkerLeaseGrant | WorkerLeaseRenewal,
  operation: "start" | "renew",
) => boolean;
/** Simulator-only observation hook proving restoration happens without status polling. */
export type SimulatedWorkerRestorationObserver = (reason: WorkerRestorationReason) => void;

/** Deterministic WorkerController implementation used by shared positive and negative fixtures. */
export class SimulatedWorkerController implements WorkerController {
  readonly #capabilities: WorkerControllerCapabilities;
  readonly #clock: SimulatedWorkerControllerClock;
  readonly #verifyAuthorization: SimulatedWorkerLeaseAuthorizationVerifier;
  readonly #onRestoration: SimulatedWorkerRestorationObserver;
  #maybeLease: ActiveLease | undefined;
  #restoration: WorkerControllerStatus["restoration"] = { status: "not_required" };

  constructor(
    capabilities: WorkerControllerCapabilities,
    clock: SimulatedWorkerControllerClock,
    verifyAuthorization: SimulatedWorkerLeaseAuthorizationVerifier,
    onRestoration: SimulatedWorkerRestorationObserver = () => undefined,
  ) {
    this.#capabilities = parseWorkerControllerCapabilities(capabilities);
    this.#clock = clock;
    this.#verifyAuthorization = verifyAuthorization;
    this.#onRestoration = onRestoration;
    this.#clock.subscribe(() => this.#enforceSafety());
  }

  async discover(): Promise<WorkerControllerCapabilities> {
    return structuredClone(this.#capabilities);
  }

  async startLease(grant: WorkerLeaseGrant): Promise<WorkerControllerStatus> {
    this.#enforceSafety();
    const parsedGrant = parseWorkerLeaseGrant(grant);
    if (!this.#verifyAuthorization(parsedGrant, "start")) {
      throw new Error("Work Lease authentication failed");
    }
    if (this.#maybeLease) throw new Error("Work Lease is already active");
    const clock = this.#clock.snapshot();
    this.#clock.acknowledgeDiscontinuity();
    this.#maybeLease = {
      grant: parsedGrant,
      continuityId: clock.continuityId,
      lastMonotonicMilliseconds: clock.monotonicMilliseconds,
      renewAtMonotonicMilliseconds: addDeadline(
        clock.monotonicMilliseconds,
        parsedGrant.renewAfterMilliseconds,
      ),
      expiresAtMonotonicMilliseconds: addDeadline(
        clock.monotonicMilliseconds,
        parsedGrant.durationMilliseconds,
      ),
    };
    this.#restoration = { status: "pending" };
    return this.#status();
  }

  async renewLease(renewal: WorkerLeaseRenewal): Promise<WorkerControllerStatus> {
    this.#enforceSafety();
    const parsedRenewal = parseWorkerLeaseRenewal(renewal);
    if (!this.#verifyAuthorization(parsedRenewal, "renew")) {
      throw new Error("Work Lease authentication failed");
    }
    const lease = this.#maybeLease;
    if (!lease) throw new Error("Work Lease is not active");
    if (lease.grant.leaseId !== parsedRenewal.leaseId) {
      throw new Error("Work Lease renewal does not match the active lease");
    }
    const clock = this.#clock.snapshot();
    lease.lastMonotonicMilliseconds = clock.monotonicMilliseconds;
    lease.renewAtMonotonicMilliseconds = addDeadline(
      clock.monotonicMilliseconds,
      parsedRenewal.renewAfterMilliseconds,
    );
    lease.expiresAtMonotonicMilliseconds = addDeadline(
      clock.monotonicMilliseconds,
      parsedRenewal.durationMilliseconds,
    );
    return this.#status();
  }

  async status(): Promise<WorkerControllerStatus> {
    this.#enforceSafety();
    return this.#status();
  }

  async pause(): Promise<WorkerControllerStatus> {
    return this.restore("paused");
  }

  async cancel(): Promise<WorkerControllerStatus> {
    return this.restore("cancelled");
  }

  async restore(reason: WorkerRestorationReason): Promise<WorkerControllerStatus> {
    this.#restoreBaseline(reason);
    return this.#status();
  }

  #enforceSafety(): void {
    const lease = this.#maybeLease;
    if (!lease) return;
    const clock = this.#clock.snapshot();
    if (clock.maybeDiscontinuity) {
      this.#restoreBaseline(clock.maybeDiscontinuity);
      this.#clock.acknowledgeDiscontinuity();
      return;
    }
    if (clock.continuityId !== lease.continuityId) {
      this.#restoreBaseline("lost_continuity");
      return;
    }
    if (clock.monotonicMilliseconds < lease.lastMonotonicMilliseconds) {
      this.#restoreBaseline("monotonic_reset");
      return;
    }
    if (clock.monotonicMilliseconds >= lease.expiresAtMonotonicMilliseconds) {
      this.#restoreBaseline("lease_expired");
      return;
    }
    lease.lastMonotonicMilliseconds = clock.monotonicMilliseconds;
  }

  #restoreBaseline(reason: WorkerRestorationReason): void {
    this.#maybeLease = undefined;
    this.#restoration = { status: "confirmed", reason };
    this.#onRestoration(reason);
  }

  #status(): WorkerControllerStatus {
    const monotonicMilliseconds = this.#clock.snapshot().monotonicMilliseconds;
    const lease = this.#maybeLease;
    if (lease) {
      return {
        protocolVersion: WORKER_CONTROLLER_PROTOCOL_VERSION,
        state: "mining",
        monotonicMilliseconds,
        lease: {
          leaseId: lease.grant.leaseId,
          challengeId: lease.grant.challengeId,
          renewAtMonotonicMilliseconds: lease.renewAtMonotonicMilliseconds,
          expiresAtMonotonicMilliseconds: lease.expiresAtMonotonicMilliseconds,
        },
        restoration: { status: "pending" },
      };
    }
    if (this.#restoration.status === "pending") {
      throw new Error("simulated Mining Baseline restoration state is inconsistent");
    }
    return {
      protocolVersion: WORKER_CONTROLLER_PROTOCOL_VERSION,
      state: "baseline",
      monotonicMilliseconds,
      restoration: structuredClone(this.#restoration),
    };
  }
}

function validateContinuityId(value: string): void {
  if (value.length === 0 || value.length > 128 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error("continuity identity is invalid");
  }
}

function validateClockValue(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`);
}

function addDeadline(now: number, duration: number): number {
  const deadline = now + duration;
  if (!Number.isSafeInteger(deadline)) throw new Error("monotonic deadline overflow");
  return deadline;
}
