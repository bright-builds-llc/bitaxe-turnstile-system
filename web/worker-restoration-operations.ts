import { maybeWorkerControlRejectionCategory } from "./worker-control-rejection";
import type { WorkerControllerStatus, WorkerRestorationReason } from "./worker-controller";
import { WorkerRestorationJournal, type WorkerRestorationJournalEvent } from "./worker-restoration-journal";
import {
  WORKER_RESTORATION_SCENARIOS, parseRestorationReplayArtifact, parseRestorationWindow,
  type AuthorizationRejectionReview, type RestorationReplayArtifact, type RestorationWindow, type WorkerRestorationHighWater, type WorkerRestorationScenario,
} from "./worker-restoration-qualification";
import type { WorkerSerialAdmissionStage, WebSerialWorkerController } from "./worker-serial-controller.types";
import { workerSerialFailureCategory, type WorkerSerialFailureCategory } from "./worker-serial-errors";

export type WorkerRestorationController = Pick<WebSerialWorkerController,
  "requestPermission" | "subscribeDisconnect" | "status" | "prepareWorkerLeaseAuthorizationContext" | "startLease" | "renewLease" |
  "pause" | "cancel" | "restore" | "close" | "clockDiscontinuityStimulus" | "clockDiscontinuityStimulusReview" | "authorizationRejectionReview">;
type ReplayOperation = "start" | "renew";
/** Closed replay result: the device's own rejection category, or a closed local transport category. */
export type WorkerRestorationReplayOutcome =
  | { operation: ReplayOperation; outcome: "accepted" }
  | { operation: ReplayOperation; outcome: "rejected"; category: string }
  | { operation: ReplayOperation; outcome: "failed"; category: WorkerSerialFailureCategory };
export type WorkerRestorationCompletion = { result: "passed" | "unverified"; scenario: WorkerRestorationScenario; cleanup_confirmed: true };
export type WorkerRestorationDevice = { state: "mining" | "baseline"; restoration: "pending" | "not_required" | "confirmed"; reason?: WorkerRestorationReason };

/** The rejection review without its raw high-water digest: only page-local continuity comparisons leave. */
export function projectAuthorizationRejectionReview(review: AuthorizationRejectionReview, highWater: Pick<WorkerRestorationHighWater, "compare">) {
  return { schema: review.schema, bootRejections: review.bootRejections, last: review.last,
    highWater: { advancedThisBoot: review.highWater.advancedThisBoot, ...highWater.compare(review.highWater.fingerprintSha256) } };
}

function categoryOf(error: unknown): string {
  return maybeWorkerControlRejectionCategory(error) ?? workerSerialFailureCategory(error);
}
function parseCheckpoint(input: unknown): { checkpoint: string } {
  if (!input || typeof input !== "object" || Object.keys(input).length !== 1 || !("checkpoint" in input) || typeof input.checkpoint !== "string" ||
    !/^[a-z][a-z0-9_]{0,63}$/u.test(input.checkpoint)) throw new Error("physical_window_state");
  return { checkpoint: input.checkpoint };
}
function parseCompletionNonce(input: unknown): string {
  if (!input || typeof input !== "object" || Object.keys(input).length !== 1 || !("nonce" in input) || typeof input.nonce !== "string") throw new Error("completion_context");
  return input.nonce;
}
/** Delivers one previously signed artifact unchanged and classifies only the closed outcome. */
async function deliverReplay(value: WorkerRestorationController, artifact: RestorationReplayArtifact): Promise<WorkerRestorationReplayOutcome> {
  const operation = artifact.operation;
  try {
    if (artifact.operation === "start") await value.startLease(artifact.grant); else await value.renewLease(artifact.renewal);
    return { operation, outcome: "accepted" };
  } catch (error) {
    const maybeRejection = maybeWorkerControlRejectionCategory(error);
    return maybeRejection ? { operation, outcome: "rejected", category: maybeRejection } : { operation, outcome: "failed", category: workerSerialFailureCategory(error) };
  }
}
function parseCompletion(input: unknown): WorkerRestorationCompletion {
  if (!input || typeof input !== "object" || Object.keys(input).length !== 3 || !("result" in input) || (input.result !== "passed" && input.result !== "unverified") ||
    !("scenario" in input) || !WORKER_RESTORATION_SCENARIOS.some(name => name === input.scenario) || !("cleanup_confirmed" in input) || input.cleanup_confirmed !== true)
    throw new Error("completion_receipt");
  return { result: input.result, scenario: input.scenario as WorkerRestorationScenario, cleanup_confirmed: true };
}

/**
 * Host-driven restoration scenarios (BWG-007). Nothing here schedules work: no timer renews, stops or
 * polls. Every lease, renewal and replay comes from the local supervisor's server-signed artifacts.
 */
export function createWorkerRestorationOperations(deps: {
  enabled(): boolean;
  createController(): WorkerRestorationController;
  local(path: string, body?: object): Promise<unknown>;
  flush(): Promise<unknown>;
  highWater: WorkerRestorationHighWater;
  identity(): object;
  publish(): void;
}) {
  const journal = new WorkerRestorationJournal();
  let maybeController: WorkerRestorationController | undefined;
  let maybeWindow: RestorationWindow | undefined;
  let maybeDevice: WorkerRestorationDevice | undefined;
  let maybeFailure: string | undefined;
  let connected = false, leaseActive = false, stimulusUsed = false, ownStop = false;
  let status = "unconfigured";

  function state() {
    return { schema: "worker-restoration-page-v1", ...deps.identity(), status, connected, leaseActive, leaseLoaded: maybeWindow !== undefined,
      renewalsRemaining: maybeWindow?.renewals.length ?? 0, stimulusUsed, highWaterEpoch: deps.highWater.epoch,
      ...(maybeDevice ? { device: { ...maybeDevice } } : {}), ...(maybeFailure ? { failure: maybeFailure } : {}), journal: journal.values() };
  }
  function changed(maybeNext?: string) { if (maybeNext) status = maybeNext; deps.publish(); }
  function endLease() { leaseActive = false; maybeWindow = undefined; }
  function controller(): WorkerRestorationController {
    if (!deps.enabled()) throw new Error("restoration_mode_required");
    if (!maybeController || !connected) throw new Error("controller_not_connected");
    return maybeController;
  }
  function idle() { const value = controller(); if (leaseActive) throw new Error("lease_active"); return value; }
  function leased() { const value = controller(); if (!leaseActive) throw new Error("lease_inactive"); return value; }
  async function observed<T>(failure: WorkerRestorationJournalEvent, run: () => Promise<T>): Promise<T> {
    try { return await run(); }
    catch (error) { journal.record(failure, categoryOf(error)); maybeFailure ??= failure; changed("failed"); throw new Error(failure); }
  }

  async function connect() {
    if (!deps.enabled()) throw new Error("restoration_mode_required");
    if (connected) throw new Error("already_connected");
    const created = deps.createController();
    maybeController = created; maybeDevice = undefined; maybeFailure = undefined; endLease();
    created.subscribeDisconnect(async () => {
      if (maybeController !== created || !connected) return;
      connected = false; endLease(); journal.record("disconnected"); changed("disconnected");
    });
    await observed("connect_failed", () => created.requestPermission());
    connected = true; journal.record("connected"); changed("ready");
    await created.status();
    changed();
    return state();
  }
  async function stopLease(event: "paused" | "cancelled" | "restored", run: (value: WorkerRestorationController) => Promise<WorkerControllerStatus>) {
    const value = leased(); ownStop = true;
    try { await observed("stop_failed", () => run(value)); } finally { ownStop = false; }
    endLease(); journal.record(event); changed("baseline_confirmed");
    return state();
  }
  async function reviewStimulus() {
    const review = await observed("review_failed", () => idle().clockDiscontinuityStimulusReview());
    journal.record("stimulus_reviewed", review.state); changed();
    return review;
  }
  async function reviewRejections() {
    const review = await observed("review_failed", () => idle().authorizationRejectionReview());
    journal.record("rejection_reviewed", review.last?.context ?? "none"); changed();
    return projectAuthorizationRejectionReview(review, deps.highWater);
  }
  async function physicalWindow(event: "begin" | "arm") {
    // Re-arming may happen while the device is unplugged or rebooting; beginning needs the active lease.
    if (event === "begin") leased(); else if (!deps.enabled()) throw new Error("restoration_mode_required");
    const result = parseCheckpoint(await deps.local("/physical-window", { event }));
    journal.record(event === "begin" ? "physical_window_begun" : "physical_window_armed", result.checkpoint); changed();
    return result;
  }
  async function replayArtifact(): Promise<WorkerRestorationReplayOutcome> {
    const value = controller();
    const artifact = parseRestorationReplayArtifact(await deps.local("/replay-artifact"));
    const operation = artifact.operation;
    if ((operation === "start") === leaseActive) throw new Error("replay_admission");
    const outcome = await deliverReplay(value, artifact);
    if (outcome.outcome === "accepted") { if (operation === "start") leaseActive = true; journal.record("replay_accepted", operation); changed("running"); return outcome; }
    journal.record(outcome.outcome === "rejected" ? "replay_rejected" : "replay_failed", outcome.category);
    // A device rejection revokes the transport epoch; wait for the controller's own fail-safe close to settle.
    if (outcome.outcome === "rejected") {
      connected = false; endLease();
      await value.close("control_failed").catch((error: unknown) => { journal.record("close_failed", categoryOf(error)); maybeFailure ??= "close_failed"; });
    }
    changed(outcome.outcome === "rejected" ? "replay_rejected" : "failed");
    return outcome;
  }
  async function close() {
    const maybeCurrent = maybeController;
    // Read status first so a lease the device already ended is never overwritten with `tab_closed`.
    if (maybeCurrent && connected && leaseActive) await maybeCurrent.status().catch((error: unknown) => journal.record("status_failed", categoryOf(error)));
    connected = false; endLease(); changed("closing");
    try { if (maybeCurrent) await maybeCurrent.close("tab_closed"); }
    catch (error) { journal.record("close_failed", categoryOf(error)); maybeFailure ??= "close_failed"; changed("restoration_unconfirmed"); throw new Error("close_failed"); }
    journal.record("closed"); changed("closed");
    return state();
  }

  return {
    state,
    configured() { journal.record("configured"); changed("configured"); },
    observeStatus(maybeValue: WorkerControllerStatus | undefined) {
      if (!maybeValue) { maybeDevice = undefined; return; }
      maybeDevice = { state: maybeValue.state, restoration: maybeValue.restoration.status, ...(maybeValue.restoration.reason ? { reason: maybeValue.restoration.reason } : {}) };
      if (maybeValue.state !== "baseline" || !leaseActive) return;
      endLease();
      if (!ownStop) { journal.record("device_baseline_observed", maybeValue.restoration.reason ?? "not_required"); changed("device_baseline"); }
    },
    observeAdmissionFailure(stage: WorkerSerialAdmissionStage) { journal.record("admission_failed", stage); },
    observeSerialFailure(category: WorkerSerialFailureCategory) { journal.record("serial_failure", category); },
    connect,
    reconnect: connect,
    async prepareStart() {
      const context = await idle().prepareWorkerLeaseAuthorizationContext("start");
      await deps.local("/authorization-context", context);
      journal.record("start_prepared"); changed();
      return state();
    },
    async loadScenarioLease() {
      if (!deps.enabled()) throw new Error("restoration_mode_required");
      if (leaseActive) throw new Error("lease_active");
      maybeWindow = parseRestorationWindow(await deps.local("/scenario-artifacts"));
      journal.record("lease_loaded", maybeWindow.renewals.length === 0 ? "no_renewal" : "one_renewal"); changed("lease_loaded");
      return state();
    },
    async startScenarioLease() {
      const value = idle(), window = maybeWindow;
      if (!window) throw new Error("lease_missing");
      try { await observed("lease_start_failed", () => value.startLease(window.grant)); } catch (error) { maybeWindow = undefined; throw error; }
      leaseActive = true; journal.record("lease_started"); changed("running");
      return state();
    },
    async renewOnce() {
      const value = leased(), maybeRenewal = maybeWindow?.renewals.shift();
      if (!maybeRenewal) throw new Error("renewal_exhausted");
      await observed("renew_failed", () => value.renewLease(maybeRenewal));
      journal.record("renewed"); changed();
      return state();
    },
    pause: () => stopLease("paused", value => value.pause()),
    cancel: () => stopLease("cancelled", value => value.cancel()),
    restoreChallengeSatisfied: () => stopLease("restored", value => value.restore("challenge_satisfied")),
    /** One use per page lifetime, consumed even when the device refuses it. */
    async triggerClockDiscontinuity() {
      if (stimulusUsed) throw new Error("stimulus_consumed");
      const value = leased();
      stimulusUsed = true; maybeWindow?.renewals.splice(0);
      const ack = await observed("stimulus_failed", () => value.clockDiscontinuityStimulus());
      journal.record("stimulus_acknowledged"); changed("stimulus_armed");
      return { schema: ack.schema, offsetMilliseconds: ack.offsetMilliseconds, armedForMilliseconds: ack.armedForMilliseconds };
    },
    clockDiscontinuityStimulusReview: reviewStimulus,
    authorizationRejectionReview: reviewRejections,
    async statusReview() {
      await observed("review_failed", () => controller().status());
      journal.record("status_reviewed", maybeDevice?.reason ?? maybeDevice?.state ?? "unknown"); changed();
      return maybeDevice ? { ...maybeDevice } : undefined;
    },
    replayArtifact,
    beginPhysicalWindow: () => physicalWindow("begin"),
    armPhysicalWindow: () => physicalWindow("arm"),
    async physicalWindowState() {
      if (!deps.enabled()) throw new Error("restoration_mode_required");
      return parseCheckpoint(await deps.local("/physical-window"));
    },
    close,
    async submitCompletion(): Promise<WorkerRestorationCompletion> {
      idle();
      if (maybeDevice?.state !== "baseline") throw new Error("completion_admission");
      const nonce = parseCompletionNonce(await deps.local("/completion-context", {}));
      const reviews = { stimulus: await reviewStimulus(), rejection: await reviewRejections() };
      await close();
      await deps.flush();
      const receipt = parseCompletion(await observed("completion_failed", () => deps.local("/completion-review", { nonce, reviews, final_state: state() })));
      journal.record("completion_submitted", receipt.result); changed("completed");
      return receipt;
    },
  };
}
