import type { WebSerialWorkerController } from "./webserial-worker-controller";

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

/** Counts only validated successful renewal acknowledgments in the current acceptance window. */
export class AcceptanceRenewalProgress {
  #confirmed = 0;
  beginWindow(): void {
    this.#confirmed = 0;
  }
  get confirmed(): number {
    return this.#confirmed;
  }
  async renew(
    controller: Pick<WebSerialWorkerController, "renewLease">,
    renewal: Parameters<WebSerialWorkerController["renewLease"]>[0],
  ): Promise<void> {
    if (this.#confirmed >= 16) throw new Error("acceptance_renewal_bound");
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
