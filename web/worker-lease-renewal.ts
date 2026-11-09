/**
 * Renew while Worker continuity holds: the headless client renews its Worker Lease on the Authority's
 * healthy-continuity cadence while work runs, skips while paused, and stops for good on any refusal
 * or once the Authority reports a terminal state.
 */
import type { HeadlessClient, HeadlessEvent } from "./headless-client.types";
import { pageClock, type PageClock } from "./page-clock";

/** The Authority's healthy-continuity Renew cadence (`WORK_LEASE_RENEWAL_SECONDS`). */
export const WORKER_LEASE_RENEWAL_MILLISECONDS = 20_000;

export type RenewalOutcome = { type: "renewed" } | { type: "refused"; message: string };

export type WorkerLeaseRenewalInput = {
  client: Pick<HeadlessClient, "subscribe" | "renewWorkerLease">;
  maybeOnOutcome?: (outcome: RenewalOutcome) => void;
  /** Defaults to the page clock, whose Worker-driven timers keep cadence in a hidden tab (ADR-0110). */
  maybeClock?: PageClock;
};

/** Starts renewing; the returned function stops it. Nothing is reported after it stops. */
export function renewWorkerLeaseWhileRunning(input: WorkerLeaseRenewalInput): () => void {
  const report = input.maybeOnOutcome ?? (() => undefined);
  let running = false;
  let renewing = false;
  let stopped = false;
  let maybeCancelTicks: (() => void) | undefined;
  let maybeUnsubscribe: (() => void) | undefined;
  const stop = () => {
    stopped = true;
    maybeCancelTicks?.();
    maybeUnsubscribe?.();
  };
  const observe = (event: HeadlessEvent) => {
    if (event.type === "terminal_reported") stop();
    if (event.type !== "lifecycle") return;
    running = event.challengeState === "active" && event.controlState === "running";
    if (TERMINAL_STATES.has(event.challengeState)) stop();
  };
  const tick = () => {
    if (stopped || !running || renewing) return;
    renewing = true;
    Promise.resolve()
      .then(() => input.client.renewWorkerLease())
      .then(
        () => {
          if (!stopped) report({ type: "renewed" });
        },
        (error: unknown) => {
          if (stopped) return;
          stop();
          report({ type: "refused", message: error instanceof Error ? error.message : String(error) });
        },
      )
      .finally(() => {
        renewing = false;
      });
  };

  maybeUnsubscribe = input.client.subscribe(observe);
  if (stopped) {
    maybeUnsubscribe();
    return stop;
  }
  maybeCancelTicks = (input.maybeClock ?? pageClock()).every(WORKER_LEASE_RENEWAL_MILLISECONDS, tick);
  return stop;
}

const TERMINAL_STATES: ReadonlySet<string> = new Set(["satisfied", "pass_issued", "cancelled", "expired"]);
