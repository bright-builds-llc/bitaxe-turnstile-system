import type { WebSerialWorkerController } from "./webserial-worker-controller";
import type { WorkerLeaseGrant } from "./worker-controller";
import type { WorkerQualification } from "./worker-qualification";
import { WORKER_SHUTDOWN_BOUND_MILLISECONDS } from "./worker-restoration-bound";
import { SOAK_MAXIMUM_ACTIVE_MILLISECONDS, SOAK_MAXIMUM_RENEWALS } from "./worker-soak-allowance";

/** Bounded qualification windows end terminally; ordinary resumable Pause remains a separate API. */
export function restoreAcceptanceBaseline(
  controller: Pick<WebSerialWorkerController, "restore">,
) {
  return controller.restore("cancelled");
}

/** Stop just before the device closes its work gate at the budget; the ordered shutdown runs after it (firmware ADR-0037). */
export function acceptanceWindowShouldStop(
  window: number,
  maximumMs: number,
  browserElapsedMs: number,
  maybeWorkGateRemainingMs: number | null | undefined,
): boolean {
  return (
    browserElapsedMs >= maximumMs ||
    (window === 0 &&
      maybeWorkGateRemainingMs !== undefined &&
      maybeWorkGateRemainingMs !== null &&
      maybeWorkGateRemainingMs <= 2_000)
  );
}

export const GENERAL_RENEWAL_LIMIT = 16;

/** Soak leases alone may carry more renewals than the general browser artifact bound. */
export function maximumWindowRenewals(grant: Pick<WorkerLeaseGrant, "soakAllowance">): number {
  return grant.soakAllowance ? SOAK_MAXIMUM_RENEWALS : GENERAL_RENEWAL_LIMIT;
}

/** The device closed the soak's work gate at its budget; renewing now would be rejected. */
export function soakWorkGateClosed(maybeQualification: Pick<WorkerQualification, "revocation_reason" | "work_gate_remaining_ms"> | undefined): boolean {
  return maybeQualification?.revocation_reason === "lease_or_budget_expired" || maybeQualification?.work_gate_remaining_ms === 0;
}

/** Up to 120 s of preparation before first dispatch, when the device arms the budget. */
export const SOAK_PREPARATION_ALLOWANCE_MILLISECONDS = 120_000;
/** The ordered safe-stop's own allowance, including its up-to-120-s cooling proof. */
export const SOAK_SAFE_STOP_ALLOWANCE_MILLISECONDS = 150_000;
/**
 * Bound on a soak's browser time from Start: preparation, the budget's mining time, the firmware's
 * shutdown bound (outside the budget since firmware ADR-0037) and the safe-stop allowance.
 */
export const SOAK_BROWSER_BACKSTOP_MILLISECONDS = SOAK_PREPARATION_ALLOWANCE_MILLISECONDS + SOAK_MAXIMUM_ACTIVE_MILLISECONDS +
  WORKER_SHUTDOWN_BOUND_MILLISECONDS + SOAK_SAFE_STOP_ALLOWANCE_MILLISECONDS;
/** Renewing this close to the device's gate close races it; the current lease already outlives the close. */
export const SOAK_RENEWAL_CUTOFF_MILLISECONDS = 5_000;

export type SoakTickDecision = "fail" | "stop" | "await_safe_stop" | "renew" | "continue";

/**
 * Soak ordering after a fresh status refresh: the device, not browser time, ends the work. Once the gate is
 * closed nothing is renewed; the window stops only after device-local safe-stop completes.
 */
export function soakTickDecision(input: {
  browserElapsedMs: number;
  nowMs: number;
  nextRenewMs: number;
  maybeQualification: Pick<WorkerQualification, "revocation_reason" | "work_gate_remaining_ms" | "safe_stop_complete" | "active_ms"> | undefined;
}): SoakTickDecision {
  const maybeQualification = input.maybeQualification;
  if (maybeQualification && maybeQualification.revocation_reason !== "none" && maybeQualification.revocation_reason !== "lease_or_budget_expired") return "fail";
  // A lease expiry reports the same reason as the budget close; only a full 600 s of work is a normal end.
  if (soakWorkGateClosed(maybeQualification) && (maybeQualification?.active_ms ?? 0) < SOAK_MAXIMUM_ACTIVE_MILLISECONDS) return "fail";
  // A completed device-local stop always ends the window, even after a long preparation.
  if (soakWorkGateClosed(maybeQualification) && maybeQualification?.safe_stop_complete) return "stop";
  if (input.browserElapsedMs >= SOAK_BROWSER_BACKSTOP_MILLISECONDS) return "fail";
  if (soakWorkGateClosed(maybeQualification)) return "await_safe_stop";
  const remaining = maybeQualification?.work_gate_remaining_ms;
  if (typeof remaining === "number" && remaining <= SOAK_RENEWAL_CUTOFF_MILLISECONDS) return "continue";
  return input.nowMs >= input.nextRenewMs ? "renew" : "continue";
}

/** Counts only validated successful renewal acknowledgments in the current acceptance window. */
export class AcceptanceRenewalProgress {
  #confirmed = 0;
  #limit = GENERAL_RENEWAL_LIMIT;
  beginWindow(limit = GENERAL_RENEWAL_LIMIT): void {
    this.#confirmed = 0;
    this.#limit = limit;
  }
  get confirmed(): number {
    return this.#confirmed;
  }
  async renew(
    controller: Pick<WebSerialWorkerController, "renewLease">,
    renewal: Parameters<WebSerialWorkerController["renewLease"]>[0],
  ): Promise<void> {
    if (this.#confirmed >= this.#limit) throw new Error("acceptance_renewal_bound");
    await controller.renewLease(renewal);
    this.#confirmed += 1;
  }
}

/** Planned qualification faults need enough fresh headroom to win before the budget stop. */
export function requireAcceptanceFaultHeadroom(
  maybeWorkGateRemainingMs: number | null | undefined,
): void {
  if (
    maybeWorkGateRemainingMs === undefined ||
    maybeWorkGateRemainingMs === null ||
    !Number.isSafeInteger(maybeWorkGateRemainingMs) ||
    maybeWorkGateRemainingMs <= 3_000
  )
    throw new Error("qualification_fault_headroom");
}
