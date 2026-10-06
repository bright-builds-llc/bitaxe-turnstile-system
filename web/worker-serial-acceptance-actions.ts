import type { WebSerialWorkerController } from "./webserial-worker-controller";
import type { WorkerLeaseGrant } from "./worker-controller";
import type { WorkerQualification } from "./worker-qualification";
import { SOAK_MAXIMUM_ACTIVE_MILLISECONDS, SOAK_MAXIMUM_RENEWALS } from "./worker-soak-allowance";

/** Bounded qualification windows end terminally; ordinary resumable Pause remains a separate API. */
export function restoreAcceptanceBaseline(
  controller: Pick<WebSerialWorkerController, "restore">,
) {
  return controller.restore("cancelled");
}

/** Stop before the device's derived work gate closes; it already reserves the ordered shutdown tail. */
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

/** Bound on a soak's browser time: the full budget, a preparation allowance and a safe-stop margin. */
export const SOAK_BROWSER_BACKSTOP_MILLISECONDS = SOAK_MAXIMUM_ACTIVE_MILLISECONDS + 60_000 + 20_000;

export type SoakTickDecision = "fail" | "stop" | "await_safe_stop" | "renew" | "continue";

/**
 * Soak ordering after a fresh status refresh: the device, not browser time, ends the work. Once the gate is
 * closed nothing is renewed; the window stops only after device-local safe-stop completes.
 */
export function soakTickDecision(input: {
  browserElapsedMs: number;
  nowMs: number;
  nextRenewMs: number;
  maybeQualification: Pick<WorkerQualification, "revocation_reason" | "work_gate_remaining_ms" | "safe_stop_complete"> | undefined;
}): SoakTickDecision {
  if (input.browserElapsedMs >= SOAK_BROWSER_BACKSTOP_MILLISECONDS) return "fail";
  const maybeQualification = input.maybeQualification;
  if (maybeQualification && maybeQualification.revocation_reason !== "none" && maybeQualification.revocation_reason !== "lease_or_budget_expired") return "fail";
  if (soakWorkGateClosed(maybeQualification)) return maybeQualification?.safe_stop_complete ? "stop" : "await_safe_stop";
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
