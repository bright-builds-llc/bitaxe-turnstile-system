import { maybeWorkerControlRejectionCategory } from "./worker-control-rejection";
import type { WorkerControllerStatus, WorkerRestorationReason } from "./worker-controller";
import { WorkerRestorationJournal, type WorkerRestorationJournalEvent } from "./worker-restoration-journal";
import { maybeRestorationAdmission, type WorkerRestorationAdmission } from "./worker-restoration-admission";
import type { WorkerSerialDiagnostic } from "./worker-serial-diagnostics";
import {
  WORKER_RESTORATION_SCENARIOS, parseRestorationReplayArtifact, parseRestorationWindow,
  WorkerRestorationDeviceIdentity, WorkerRestorationPoolConfiguration,
  type AuthorizationRejectionReview, type RestorationReplayArtifact, type RestorationWindow, type WorkerRestorationHighWater, type WorkerRestorationScenario,
} from "./worker-restoration-qualification";
import type { WorkerPreservation } from "./worker-preservation";
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

export type WorkerRestorationDependencies = {
  enabled(): boolean;
  createController(): WorkerRestorationController;
  local(path: string, body?: object): Promise<unknown>;
  flush(): Promise<unknown>;
  highWater: WorkerRestorationHighWater;
  identity(): object;
  publish(): void;
};

/** One page lifetime's restoration state and its admission guards. */
class RestorationSession {
  readonly journal = new WorkerRestorationJournal();
  readonly deviceIdentity = new WorkerRestorationDeviceIdentity();
  readonly poolConfiguration = new WorkerRestorationPoolConfiguration();
  maybeController: WorkerRestorationController | undefined;
  maybeWindow: RestorationWindow | undefined;
  maybeDevice: WorkerRestorationDevice | undefined;
  maybeFailure: string | undefined;
  maybeAdmission: WorkerRestorationAdmission | undefined;
  connected = false;
  leaseActive = false;
  stimulusUsed = false;
  ownStop = false;
  status = "unconfigured";
  constructor(readonly deps: WorkerRestorationDependencies) {}
  state() {
    return { schema: "worker-restoration-page-v1", ...this.deps.identity(), status: this.status, connected: this.connected, leaseActive: this.leaseActive,
      leaseLoaded: this.maybeWindow !== undefined, renewalsRemaining: this.maybeWindow?.renewals.length ?? 0, stimulusUsed: this.stimulusUsed,
      highWaterEpoch: this.deps.highWater.epoch, ...(this.maybeDevice ? { device: { ...this.maybeDevice } } : {}),
      ...(this.maybeFailure ? { failure: this.maybeFailure } : {}), admission: this.admission(),
      deviceIdentity: this.deviceIdentity.publicState(), poolConfiguration: this.poolConfiguration.publicState(), journal: this.journal.values() };
  }
  admission(): WorkerRestorationAdmission | null { return this.maybeAdmission ? { ...this.maybeAdmission } : null; }
  changed(maybeNext?: string) { if (maybeNext) this.status = maybeNext; this.deps.publish(); }
  endLease() { this.leaseActive = false; this.maybeWindow = undefined; }
  requireEnabled() { if (!this.deps.enabled()) throw new Error("restoration_mode_required"); }
  controller(): WorkerRestorationController {
    this.requireEnabled();
    if (!this.maybeController || !this.connected) throw new Error("controller_not_connected");
    return this.maybeController;
  }
  idle() { const value = this.controller(); if (this.leaseActive) throw new Error("lease_active"); return value; }
  leased() { const value = this.controller(); if (!this.leaseActive) throw new Error("lease_inactive"); return value; }
  async observed<T>(failure: WorkerRestorationJournalEvent, run: () => Promise<T>): Promise<T> {
    try { return await run(); }
    catch (error) { this.journal.record(failure, categoryOf(error)); this.maybeFailure ??= failure; this.changed("failed"); throw new Error(failure); }
  }
}

async function connect(s: RestorationSession) {
  s.requireEnabled();
  if (s.connected) throw new Error("already_connected");
  const created = s.deps.createController();
  s.maybeController = created; s.maybeDevice = undefined; s.maybeFailure = undefined; s.endLease();
  created.subscribeDisconnect(async () => {
    if (s.maybeController !== created || !s.connected) return;
    s.connected = false; s.endLease(); s.journal.record("disconnected"); s.changed("disconnected");
  });
  await s.observed("connect_failed", () => created.requestPermission());
  s.connected = true; s.journal.record("connected"); s.changed("ready");
  await created.status();
  s.changed();
  return s.state();
}

function observeStatus(s: RestorationSession, maybeValue: WorkerControllerStatus | undefined) {
  if (!maybeValue) { s.maybeDevice = undefined; return; }
  s.maybeDevice = { state: maybeValue.state, restoration: maybeValue.restoration.status, ...(maybeValue.restoration.reason ? { reason: maybeValue.restoration.reason } : {}) };
  if (maybeValue.state !== "baseline" || !s.leaseActive) return;
  s.endLease();
  if (!s.ownStop) { s.journal.record("device_baseline_observed", maybeValue.restoration.reason ?? "not_required"); s.changed("device_baseline"); }
}

/**
 * Keeps the latest firmware admission stage across reconnects and journals each change of its first failure
 * (including the first observation). Observation only: no Gate transition depends on it.
 */
function observeDiagnostic(s: RestorationSession, value: WorkerSerialDiagnostic) {
  const maybeNext = s.deps.enabled() ? maybeRestorationAdmission(value) : undefined;
  if (!maybeNext) return;
  const maybePrevious = s.maybeAdmission;
  s.maybeAdmission = maybeNext;
  if (maybePrevious?.firstFailure !== maybeNext.firstFailure) s.journal.record("admission_observed", maybeNext.firstFailure);
  if (!maybePrevious || maybePrevious.firstFailure !== maybeNext.firstFailure || maybePrevious.stage !== maybeNext.stage || maybePrevious.readiness !== maybeNext.readiness) s.changed();
}

/** Page-local identity and pool trackers; the raw digests they consume never leave this page. */
function observePreservation(s: RestorationSession, value: WorkerPreservation) {
  if (!s.deps.enabled()) return;
  if (s.deviceIdentity.observe(value)) s.journal.record("device_identity_changed");
  if (s.poolConfiguration.observe(value)) s.journal.record("pool_configuration_changed");
  s.changed();
}

async function stopLease(s: RestorationSession, event: "paused" | "cancelled" | "restored", run: (value: WorkerRestorationController) => Promise<WorkerControllerStatus>) {
  const value = s.leased(); s.ownStop = true;
  try { await s.observed("stop_failed", () => run(value)); } finally { s.ownStop = false; }
  s.endLease(); s.journal.record(event); s.changed("baseline_confirmed");
  return s.state();
}

/** Scenario lease steps; every artifact comes from the local supervisor and nothing renews on its own. */
function leaseOperations(s: RestorationSession) {
  return {
    async prepareStart() {
      const context = await s.idle().prepareWorkerLeaseAuthorizationContext("start");
      await s.deps.local("/authorization-context", context);
      s.journal.record("start_prepared"); s.changed();
      return s.state();
    },
    async loadScenarioLease() {
      s.requireEnabled();
      if (s.leaseActive) throw new Error("lease_active");
      const window = parseRestorationWindow(await s.deps.local("/scenario-artifacts"));
      s.maybeWindow = window;
      s.journal.record("lease_loaded", window.renewals.length === 0 ? "no_renewal" : "one_renewal"); s.changed("lease_loaded");
      return s.state();
    },
    async startScenarioLease() {
      const value = s.idle(), window = s.maybeWindow;
      if (!window) throw new Error("lease_missing");
      try { await s.observed("lease_start_failed", () => value.startLease(window.grant)); } catch (error) { s.maybeWindow = undefined; throw error; }
      s.leaseActive = true; s.journal.record("lease_started"); s.changed("running");
      return s.state();
    },
    async renewOnce() {
      const value = s.leased(), maybeRenewal = s.maybeWindow?.renewals.shift();
      if (!maybeRenewal) throw new Error("renewal_exhausted");
      await s.observed("renew_failed", () => value.renewLease(maybeRenewal));
      s.journal.record("renewed"); s.changed();
      return s.state();
    },
    pause: () => stopLease(s, "paused", value => value.pause()),
    cancel: () => stopLease(s, "cancelled", value => value.cancel()),
    restoreChallengeSatisfied: () => stopLease(s, "restored", value => value.restore("challenge_satisfied")),
    /** One use per page lifetime, consumed even when the device refuses it. */
    async triggerClockDiscontinuity() {
      if (s.stimulusUsed) throw new Error("stimulus_consumed");
      const value = s.leased();
      s.stimulusUsed = true; s.maybeWindow?.renewals.splice(0);
      const ack = await s.observed("stimulus_failed", () => value.clockDiscontinuityStimulus());
      s.journal.record("stimulus_acknowledged"); s.changed("stimulus_armed");
      return { schema: ack.schema, offsetMilliseconds: ack.offsetMilliseconds, armedForMilliseconds: ack.armedForMilliseconds };
    },
  };
}

async function reviewStimulus(s: RestorationSession) {
  const review = await s.observed("review_failed", () => s.idle().clockDiscontinuityStimulusReview());
  s.journal.record("stimulus_reviewed", review.state); s.changed();
  return review;
}
async function reviewRejections(s: RestorationSession) {
  const review = await s.observed("review_failed", () => s.idle().authorizationRejectionReview());
  s.journal.record("rejection_reviewed", review.last?.context ?? "none"); s.changed();
  return projectAuthorizationRejectionReview(review, s.deps.highWater);
}
async function reviewStatus(s: RestorationSession) {
  await s.observed("review_failed", () => s.controller().status());
  s.journal.record("status_reviewed", s.maybeDevice?.reason ?? s.maybeDevice?.state ?? "unknown"); s.changed();
  return s.maybeDevice ? { ...s.maybeDevice } : undefined;
}

async function physicalWindow(s: RestorationSession, event: "begin" | "arm") {
  // Re-arming may happen while the device is unplugged or rebooting; beginning needs the active lease.
  if (event === "begin") s.leased(); else s.requireEnabled();
  const result = parseCheckpoint(await s.deps.local("/physical-window", { event }));
  s.journal.record(event === "begin" ? "physical_window_begun" : "physical_window_armed", result.checkpoint); s.changed();
  return result;
}

async function replayArtifact(s: RestorationSession): Promise<WorkerRestorationReplayOutcome> {
  const value = s.controller();
  const artifact = parseRestorationReplayArtifact(await s.deps.local("/replay-artifact"));
  const operation = artifact.operation;
  if ((operation === "start") === s.leaseActive) throw new Error("replay_admission");
  const outcome = await deliverReplay(value, artifact);
  if (outcome.outcome === "accepted") { if (operation === "start") s.leaseActive = true; s.journal.record("replay_accepted", operation); s.changed("running"); return outcome; }
  s.journal.record(outcome.outcome === "rejected" ? "replay_rejected" : "replay_failed", outcome.category);
  // A device rejection revokes the transport epoch; wait for the controller's own fail-safe close to settle.
  if (outcome.outcome === "rejected") {
    s.connected = false; s.endLease();
    await value.close("control_failed").catch((error: unknown) => { s.journal.record("close_failed", categoryOf(error)); s.maybeFailure ??= "close_failed"; });
  }
  s.changed(outcome.outcome === "rejected" ? "replay_rejected" : "failed");
  return outcome;
}

async function close(s: RestorationSession) {
  const maybeCurrent = s.maybeController;
  // Read status first so a lease the device already ended is never overwritten with `tab_closed`.
  if (maybeCurrent && s.connected && s.leaseActive) await maybeCurrent.status().catch((error: unknown) => s.journal.record("status_failed", categoryOf(error)));
  s.connected = false; s.endLease(); s.changed("closing");
  try { if (maybeCurrent) await maybeCurrent.close("tab_closed"); }
  catch (error) { s.journal.record("close_failed", categoryOf(error)); s.maybeFailure ??= "close_failed"; s.changed("restoration_unconfirmed"); throw new Error("close_failed"); }
  s.journal.record("closed"); s.changed("closed");
  return s.state();
}

async function submitCompletion(s: RestorationSession): Promise<WorkerRestorationCompletion> {
  s.idle();
  if (s.maybeDevice?.state !== "baseline") throw new Error("completion_admission");
  const nonce = parseCompletionNonce(await s.deps.local("/completion-context", {}));
  const reviews = { stimulus: await reviewStimulus(s), rejection: await reviewRejections(s) };
  await close(s);
  await s.deps.flush();
  const receipt = parseCompletion(await s.observed("completion_failed", () => s.deps.local("/completion-review", { nonce, reviews, final_state: s.state() })));
  s.journal.record("completion_submitted", receipt.result); s.changed("completed");
  return receipt;
}

/**
 * Host-driven restoration scenarios (BWG-007). Nothing here schedules work: no timer renews, stops or
 * polls. Every lease, renewal and replay comes from the local supervisor's server-signed artifacts.
 */
export function createWorkerRestorationOperations(deps: WorkerRestorationDependencies) {
  const s = new RestorationSession(deps);
  return {
    state: () => s.state(),
    configured() { s.journal.record("configured"); s.changed("configured"); },
    observeStatus: (maybeValue: WorkerControllerStatus | undefined) => observeStatus(s, maybeValue),
    observeAdmissionFailure(stage: WorkerSerialAdmissionStage) { s.journal.record("admission_failed", stage); },
    observeSerialFailure(category: WorkerSerialFailureCategory) { s.journal.record("serial_failure", category); },
    observeDiagnostic: (value: WorkerSerialDiagnostic) => observeDiagnostic(s, value),
    observePreservation: (value: WorkerPreservation) => observePreservation(s, value),
    connect: () => connect(s),
    reconnect: () => connect(s),
    ...leaseOperations(s),
    clockDiscontinuityStimulusReview: () => reviewStimulus(s),
    authorizationRejectionReview: () => reviewRejections(s),
    statusReview: () => reviewStatus(s),
    replayArtifact: () => replayArtifact(s),
    beginPhysicalWindow: () => physicalWindow(s, "begin"),
    armPhysicalWindow: () => physicalWindow(s, "arm"),
    async physicalWindowState() { s.requireEnabled(); return parseCheckpoint(await deps.local("/physical-window")); },
    /** The latest non-authoritative admission diagnostic already received; sends no device command. */
    async admissionDiagnostic() { s.requireEnabled(); return { admission: s.admission() }; },
    close: () => close(s),
    submitCompletion: () => submitCompletion(s),
  };
}
