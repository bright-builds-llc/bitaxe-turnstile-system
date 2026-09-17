import { createWorkerAcceptanceAuthorization } from "./worker-acceptance-authorization";
import { requireWorkerV2ShareMode } from "./worker-v2-configuration";
import { drainWorkerAcceptancePoll, captureWorkerV2HeartbeatFault, serializeWorkerAcceptanceRead } from "./worker-acceptance-fault";
import { createWorkerV2PageOperations, WorkerV2ShareStartClaim } from "./worker-v2-page";
import { isWorkerV2Stratum } from "./worker-v2-stratum";
import { isWorkerRestorationPending } from "./worker-control-rejection";
import { createWorkerNoisePageOperations } from "./worker-noise-page";
import { acceptanceLocalJson as localJson } from "./worker-acceptance-local";
import { createWorkerRestartPageOperations } from "./worker-restart-page";
import { WorkerCadenceAcceptance } from "./worker-cadence-acceptance";
import { createWorkerCadencePageOperations } from "./worker-cadence-page";
import { requireWorkerOwnerHeadroom, workerOwnerResourceFailure, type WorkerOwnerResourceFailure } from "./worker-owner-resources";
import { workerDeviceBaselineConfirmed } from "./worker-device-baseline";
import { acceptancePurposeWindow, acceptanceMaximumActiveMilliseconds } from "./worker-acceptance-purpose";
import { parseWorkerDiagnosticExport } from "./worker-diagnostic-export";
import { diagnosticInitialWorkCaptured } from "./worker-diagnostic-work";
import { WorkerRecoveryLoss, flushRecoverySupervisor } from "./worker-recovery-loss";
import { WorkerBrowserSerialTrace } from "./worker-browser-serial-trace";
import { parseBrowserSerialTrace } from "./worker-serial-trace-export";
import { reviewDeviceSerialTrace } from "./worker-serial-trace-review";
import { WorkerAuthorizationRecoveryCheckpoint } from "./worker-authorization-recovery";
import { requireWorkerAcceptanceModeTransition, parseWorkerSerialAcceptanceConfiguration, type WorkerSerialAcceptanceConfiguration as Configuration } from "./worker-serial-acceptance-config";
import { submitWorkerCoolingReview } from "./worker-cooling-review";
import type { WorkerLeaseAuthorizationContext } from "./worker-lease-authorization";
import { WorkerSerialDiagnosticHistory } from "./worker-serial-diagnostics";
import { restoreAcceptanceBaseline, acceptanceWindowShouldStop, AcceptanceRenewalProgress, requireAcceptanceFaultHeadroom } from "./worker-serial-acceptance-actions";
import { WorkerPreservationBaseline } from "./worker-preservation";
import {
  createWebSerialWorkerController,
  workerSerialQualificationHook,
  type WebSerialWorkerController,
  type WebSerialWorkerControllerInput,
  type WorkerSerialQualificationHook,
} from "./webserial-worker-controller";
import { parseWorkerLeaseGrant, parseWorkerLeaseRenewal, type WorkerLeaseGrant, type WorkerLeaseRenewal, type WorkerQualification } from "./worker-controller";

declare const BWG_GATE_SOURCE_COMMIT: string;
const gateCommit = typeof BWG_GATE_SOURCE_COMMIT === "string" ? BWG_GATE_SOURCE_COMMIT : "Unavailable";
type WindowArtifacts = {
  grant: WorkerLeaseGrant;
  renewals: WorkerLeaseRenewal[];
};
const preservation = new WorkerPreservationBaseline();
const v2ShareStartClaim = new WorkerV2ShareStartClaim();
const recoveryLoss = new WorkerRecoveryLoss();
const cadence = new WorkerCadenceAcceptance();
const browserTrace = new WorkerBrowserSerialTrace(() => performance.now());
const authorizationRecovery = new WorkerAuthorizationRecoveryCheckpoint();
const renewalProgress = new AcceptanceRenewalProgress();
let deviceRestorationConfirmed = false,
  deviceLeaseInactive = false;
let deviceBaselineConfirmed = false;
let maybeAdmissionFailureStage: string | undefined;
let maybeSerialFailureCategory: string | undefined;
let maybeHelloRecovery: { discardedRecords: number; discardedReplies: number; discardedBytes: number } | undefined;
let serialOwnershipReleased = true;
const localDiagnostics = new WorkerSerialDiagnosticHistory();
function publishDiagnostics() {
  const output = document.querySelector("#diagnostics");
  if (output) output.textContent = JSON.stringify(localDiagnostics.values(), null, 2);
}
const hook: WorkerSerialQualificationHook = {
  maybeTraceHistory: browserTrace,
  maybeObserveHelloRecovery(value) { maybeHelloRecovery = value; },
  maybeObserveSerialFailure(category) { maybeSerialFailureCategory ??= category; },
  maybeObserveDiagnostic(value) {
    localDiagnostics.observe(value);
    publishDiagnostics();
  },
  maybeObserveAdmissionFailure(stage) { maybeAdmissionFailureStage ??= stage; },
  maybeObserveSerialOwnership(released) { serialOwnershipReleased = released; publish(); },
  observeStatus: (value) => {
    authorizationRecovery.observeStatus(value);
    cadence.observe(value, performance.now());
    deviceBaselineConfirmed = workerDeviceBaselineConfirmed(value);
    deviceLeaseInactive = value?.state === "baseline";
    deviceRestorationConfirmed =
      value?.state === "baseline" && value.restoration.status === "confirmed";
    if (value) maybeQualification = value.qualification;
  },
  observePreservation: (value) => { preservation.observe(value); authorizationRecovery.observePreservation(value); },
  suppressHeartbeats: false,
  memoryOnlyContinuity: true,
  async prepareScope() {
    const value = await localJson("/activate", {});
    if (
      !value ||
      typeof value !== "object" ||
      Object.keys(value).length !== 2 ||
      typeof value.challengeId !== "string" ||
      !Number.isSafeInteger(value.retentionExpiryUnixSeconds)
    )
      throw new Error("activation_invalid");
    return {
      challengeId: value.challengeId,
      retentionExpiryUnixSeconds: value.retentionExpiryUnixSeconds,
    };
  },
};
let maybeConfiguration: Configuration | undefined;
let maybeReviewedContext: WorkerLeaseAuthorizationContext | undefined;
let maybeController: WebSerialWorkerController | undefined;
let maybeWindow: WindowArtifacts | undefined;
let maybeTimer: ReturnType<typeof setInterval> | undefined;
let polling = false;
const serializeRead = <T>(run: () => Promise<T>) => serializeWorkerAcceptanceRead({ polling: () => polling, claim: value => { polling = value; }, run });
let status = "unconfigured";
let maybeFailure: string | undefined;
let maybeQualification: WorkerQualification | undefined;
let maybeOwnerResourceFailure: WorkerOwnerResourceFailure | undefined;
let maybeProbe: unknown;
let connected = false, running = false;
let began = 0,
  nextRenew = 0;

function publish() {
  const output = document.querySelector("#state");
  if (output) output.textContent = JSON.stringify(state(), null, 2);
}
function state() {
  return {
    schema: "worker-serial-acceptance-v1",
    gateCommit,
    status,
    connected,
    running,
    heartbeatSuppressed: hook.suppressHeartbeats,
    ...(maybeController?.qualificationRestartSummary() ? { restart: maybeController.qualificationRestartSummary() } : {}),
    ...(cadence.enabled ? { cadence: cadence.state() } : {}),
    renewalsConfirmed: renewalProgress.confirmed,
    serialOwnershipReleased,
    ...(maybeHelloRecovery ? { helloRecovery: maybeHelloRecovery } : {}),
    deviceRestorationConfirmed,
    deviceBaselineConfirmed,
    deviceLeaseInactive,
    ...(maybeConfiguration
      ? {
        expectedFirmwareSourceCommit:
          maybeConfiguration.expectedFirmwareSourceCommit,
        expectedAppElfSha256: maybeConfiguration.expectedAppElfSha256,
      }
      : {}),
    ...(maybeQualification ? { qualification: maybeQualification } : {}),
    ...(authorizationRecovery.maybePublicState() ? { authorizationRecovery: authorizationRecovery.maybePublicState() } : {}),
    ...(maybeOwnerResourceFailure ? { ownerResourceFailure: maybeOwnerResourceFailure } : {}),
    ...(preservation.maybePublicState()
      ? { preservation: preservation.maybePublicState() }
      : {}),
    ...(maybeProbe ? { probe: maybeProbe } : {}),
    ...(maybeFailure ? { failure: maybeFailure } : {}),
    ...(maybeSerialFailureCategory ? { serialFailureCategory: maybeSerialFailureCategory } : {}),
    ...(maybeAdmissionFailureStage ? { admissionFailureStage: maybeAdmissionFailureStage } : {}),
  };
}
function controller() {
  if (!maybeController || !connected)
    throw new Error("controller_not_connected");
  return maybeController;
}
function stopTimer() {
  if (maybeTimer) clearInterval(maybeTimer);
  maybeTimer = undefined;
}
async function fail(category: string) {
  maybeFailure = category;
  status = "failed";
  running = false;
  stopTimer();
  publish();
}
function configure(input: Configuration) {
  if (connected || running || maybeWindow || !serialOwnershipReleased) throw new Error("configuration_while_connected");
  const parsed = parseWorkerSerialAcceptanceConfiguration(input, gateCommit);
  requireWorkerAcceptanceModeTransition(maybeConfiguration, parsed);
  if ((maybeConfiguration?.noiseQualification === "before" && parsed.noiseQualification === "candidate") || (maybeConfiguration?.stratumV2Qualification === "before" && parsed.stratumV2Qualification === "candidate")) {
    const maybeBaseline = preservation.maybePublicState();
    if (!maybeBaseline || !maybeBaseline.settings_match || !maybeBaseline.authorization_high_water_match || !maybeBaseline.device_identity_match || maybeBaseline.mine_on_boot) throw new Error("noise_before_baseline_required");
  }
  if (parsed.noiseQualification === "candidate") hook.noiseDiagnosticPair = { firmwareSourceCommit: parsed.expectedFirmwareSourceCommit, appElfSha256: parsed.expectedAppElfSha256 };
  else delete hook.noiseDiagnosticPair;
  if (parsed.stratumV2Qualification === "candidate" && parsed.stratumV2Scope) hook.stratumV2Pair = { firmwareSourceCommit: parsed.expectedFirmwareSourceCommit, appElfSha256: parsed.expectedAppElfSha256, scope: parsed.stratumV2Scope };
  else delete hook.stratumV2Pair;
  cadence.configure(parsed.cadenceQualification);
  recoveryLoss.configure(parsed.recoveryPhase);
  if (parsed.recoveryPhase === "resume") authorizationRecovery.clearForResume(recoveryLoss.sealed);
  hook.allowQualificationRestart = parsed.restartQualification === true;
  maybeConfiguration = parsed;
  deviceBaselineConfirmed = false;
  status = "configured";
  maybeFailure = undefined;
  publish();
}
async function connect() {
  maybeReviewedContext = undefined;
  const config = maybeConfiguration;
  if (!config) throw new Error("configuration_missing");
  if (connected) throw new Error("already_connected");
  authorizationRecovery.beginSession();
  deviceBaselineConfirmed = false;
  maybeHelloRecovery = undefined;
  hook.suppressHeartbeats = false;
  maybeAdmissionFailureStage = undefined;
  maybeSerialFailureCategory = undefined;
  localDiagnostics.clear();
  publishDiagnostics();
  const input: WebSerialWorkerControllerInput & {
    [workerSerialQualificationHook]: WorkerSerialQualificationHook;
  } = {
    deviceFilter: { usbVendorId: 0x303a, usbProductId: 0x1001 },
    trustedUpdateKeys: config.trust.updateAuthority.keys,
    continuityScope: {
      challengeId: "challenge_pending_serial_permission",
      retentionExpiryUnixSeconds: 1,
    },
    expectedFirmwareSourceCommit: config.expectedFirmwareSourceCommit,
    expectedAppElfSha256: config.expectedAppElfSha256,
    [workerSerialQualificationHook]: hook,
  };
  maybeController = createWebSerialWorkerController(input);
  maybeController.subscribeDisconnect(async () => {
    connected = false;
    running = false;
    stopTimer();
    status = "disconnected";
    publish();
  });
  await maybeController.requestPermission();
  connected = true;
  status = "ready";
  maybeFailure = undefined;
  const observed = await maybeController.status();
  maybeQualification = observed.qualification;
  publish();
  return state();
}
const { prepareStartAuthorization, submitBudgetReview } = createWorkerAcceptanceAuthorization({
  requireStartScope() {
    if (maybeConfiguration?.restartQualification) throw new Error("restart_forbids_work");
    if (maybeConfiguration?.noiseQualification) throw new Error("noise_forbids_work");
    requireWorkerV2ShareMode(maybeConfiguration);
  },
  maybeReviewedContext: () => maybeReviewedContext, reviewedContext: value => { maybeReviewedContext = value; },
  prove: () => controller().prepareWorkerLeaseAuthorizationContext("start"),
  showBinding(binding) { const output = document.querySelector<HTMLTextAreaElement>("#authorization-context"); if (output) output.value = binding; },
  attemptReview: () => controller().qualificationAttemptReview(), budgetReview: reviewBudget, state, local: localJson,
});

function loadWindow(input: WindowArtifacts) {
  if (maybeConfiguration?.restartQualification) throw new Error("restart_forbids_work");
  if (maybeConfiguration?.noiseQualification) throw new Error("noise_forbids_work");
  requireWorkerV2ShareMode(maybeConfiguration);
  if (running) throw new Error("window_active");
  const grant = parseWorkerLeaseGrant(input.grant);
  cadence.requireWindow(grant);
  if (maybeConfiguration?.stratumV2Qualification && (!isWorkerV2Stratum(grant.stratum) || grant.qualificationAttempt?.purpose !== "normal" || grant.qualificationAttempt.maximumActiveMilliseconds !== 180000 || grant.durationMilliseconds !== 60000 || grant.renewAfterMilliseconds !== 20000)) throw new Error("v2_share_window");
  if (!grant.acceptanceCampaign && !grant.qualificationAttempt)
    throw new Error("acceptance_campaign_required");
  if (!Array.isArray(input.renewals) || input.renewals.length > 16)
    throw new Error("renewal_bound");
  const renewals = input.renewals.map(parseWorkerLeaseRenewal);
  if (maybeConfiguration?.stratumV2Qualification && renewals.some(value => value.durationMilliseconds !== 60000 || value.renewAfterMilliseconds !== 20000)) throw new Error("v2_renewal_window");
  if (renewals.some((value) => value.leaseId !== grant.leaseId))
    throw new Error("renewal_lease_mismatch");
  maybeWindow = { grant, renewals };
  status = "window_loaded";
  publish();
}
async function loadSignedWindow() {
  if (maybeConfiguration?.restartQualification) throw new Error("restart_forbids_work");
  if (maybeConfiguration?.noiseQualification) throw new Error("noise_forbids_work");
  requireWorkerV2ShareMode(maybeConfiguration);
  loadWindow(await localJson("/window-artifacts"));
  return state();
}

async function enforceRunningHeadroom() {
  if (!running || !maybeWindow) return true;
  try { requireWorkerOwnerHeadroom(maybeWindow.grant, maybeQualification); return true; }
  catch {
    maybeOwnerResourceFailure ??= workerOwnerResourceFailure(maybeQualification);
    await fail("window_control_failed");
    await close().catch(() => { status = "restoration_unconfirmed"; });
    maybeFailure = "window_control_failed";
    publish();
    return false;
  }
}
async function refresh() {
  const observed = await controller().status();
  maybeQualification = observed.qualification;
  publish();
  await enforceRunningHeadroom();
  return state();
}
async function tick() {
  if (polling || !running || !maybeWindow) return;
  polling = true;
  try {
    const now = performance.now();
    const duration = acceptanceMaximumActiveMilliseconds(maybeWindow.grant);
    if (duration === undefined) throw new Error("campaign_missing");
    if (now - began >= duration) {
      await stop();
      return;
    }
    if (now >= nextRenew) {
      const renewal = maybeWindow.renewals.shift();
      if (!renewal) throw new Error("renewal_exhausted");
      await renewalProgress.renew(controller(), renewal);
      nextRenew = performance.now() + renewal.renewAfterMilliseconds;
    }
    await refresh();
    if (!running || !maybeWindow) return;
    if (cadence.shouldSuppress(performance.now())) { await suppressCadenceHeartbeats(); return; }
    if (maybeWindow.grant.qualificationAttempt?.purpose === "diagnostic" && diagnosticInitialWorkCaptured(maybeQualification)) { await finishDiagnosticWork(); return; }
    if (
      acceptanceWindowShouldStop(
        acceptancePurposeWindow(maybeWindow.grant),
        duration,
        performance.now() - began,
        maybeQualification?.work_gate_remaining_ms,
      )
    )
      await stop();
  } catch {
    await fail("window_control_failed");
    await close().catch(() => fail("cleanup_failed"));
  } finally {
    polling = false;
  }
}
async function startWindow() {
  const input = maybeWindow;
  if (!input || running) throw new Error("window_missing_or_active");
  if (maybeConfiguration?.stratumV2Qualification) v2ShareStartClaim.consume();
  maybeOwnerResourceFailure = undefined;
  const observed = await controller().startLease(input.grant);
  maybeQualification = observed.qualification;
  renewalProgress.beginWindow();
  running = true;
  status = "running";
  began = performance.now();
  nextRenew = began + input.grant.renewAfterMilliseconds;
  publish();
  if (!await enforceRunningHeadroom()) return state();
  if (input.grant.qualificationAttempt?.purpose === "diagnostic" && diagnosticInitialWorkCaptured(maybeQualification)) return finishDiagnosticWork();
  maybeTimer = setInterval(() => {
    void tick();
  }, 1000);
  publish();
  return state();
}
async function finishDiagnosticWork() {
  if (!recoveryLoss.armed) return stop();
  await recoveryLoss.cut({
    prepareBoundary: () => { authorizationRecovery.capture(maybeQualification?.generation); publish(); },
    cleanupAfterFailure: async () => { await fail("recovery_loss_failed"); await close(); },
    snapshot: state, flush: flushRecoverySupervisor, disconnect: () => controller().qualificationAbruptDisconnect(),
    publishClosed: () => { maybeReviewedContext = undefined; stopTimer(); maybeWindow = undefined; connected = false; running = false; status = "closed"; publish(); },
    submit: body => localJson("/recovery-loss", body),
  });
  return state();
}
async function stop() {
  stopTimer();
  running = false;
  status = "stopping";
  publish();
  let observed;
  try { observed = await restoreAcceptanceBaseline(controller()); }
  catch (error) {
    if ((maybeConfiguration?.noiseQualification || maybeConfiguration?.stratumV2Qualification) && isWorkerRestorationPending(error)) {
      status = "restoration_pending"; deviceBaselineConfirmed = false; deviceRestorationConfirmed = false; publish();
    }
    throw error;
  }
  maybeQualification = observed.qualification;
  running = false;
  maybeWindow = undefined;
  status = "baseline_confirmed";
  publish();
  return state();
}
async function close() {
  maybeReviewedContext = undefined;
  stopTimer();
  const current = maybeController;
  maybeWindow = undefined;
  connected = false;
  running = false;
  status = "closing";
  publish();
  try {
    if (current) await current.close("tab_closed");
    status = "closed";
  } catch {
    status = "restoration_unconfirmed";
    maybeFailure = "close_failed";
    throw new Error("close_failed");
  } finally {
    publish();
  }
  return state();
}
async function probe() {
  maybeProbe = await controller().transportProbe();
  publish();
  return maybeProbe;
}
async function requirePlannedFault(window: 1 | 2) {
  if (!running || !maybeWindow || acceptancePurposeWindow(maybeWindow.grant) !== window)
    throw new Error("qualification_window_required");
  stopTimer();
  await drainWorkerAcceptancePoll(() => polling);
  await refresh();
  if (!running) throw new Error("window_control_failed");
  requireAcceptanceFaultHeadroom(maybeQualification?.work_gate_remaining_ms);
}
async function armForegroundLoss() {
  await requirePlannedFault(1);
  return state();
}
async function suppressHeartbeats() {
  if (maybeConfiguration?.stratumV2Qualification) {
    if (maybeConfiguration.stratumV2Scope !== "share" || !running || !maybeWindow) throw new Error("v2_fault_admission");
    stopTimer();
    const headroom = await serializeRead(() => captureWorkerV2HeartbeatFault({
      status: () => controller().status(),
      observe(fresh) { maybeQualification = fresh.qualification; authorizationRecovery.capture(maybeQualification?.generation); },
      suppress() { hook.suppressHeartbeats = true; },
    }));
    publish(); return headroom;
  }
  await requirePlannedFault(2);
  hook.suppressHeartbeats = true;
  publish();
}

async function reviewBudget(campaignId: string) {
  if (!maybeController || running) throw new Error("budget_review_admission");
  return maybeController.acceptanceBudgetReview(campaignId);
}


async function rejectStartForRecoveryTest() {
  if (maybeConfiguration?.noiseQualification) throw new Error("noise_forbids_competing_effect");
  if (maybeConfiguration?.stratumV2Qualification) throw new Error("v2_forbids_competing_effect");
  maybeReviewedContext = undefined;
  if (!maybeConfiguration || running) throw new Error("rejection_fixture_admission");
  try {
    return await controller().rejectStartForRecoveryTest(maybeConfiguration.trust.workLeaseAuthority);
  } finally {
    connected = false;
    status = "closed";
    publish();
  }
}

async function interruptPendingStatusForQualification() {
  if (maybeConfiguration?.noiseQualification) throw new Error("noise_forbids_competing_effect");
  if (maybeConfiguration?.stratumV2Qualification) throw new Error("v2_forbids_competing_effect");
  maybeReviewedContext = undefined;
  if (running || maybeWindow) throw new Error("read_interruption_admission");
  const receipt = await controller().interruptPendingStatusForQualification();
  if (receipt.interrupted) {
    connected = false;
    running = false;
    stopTimer();
    status = "closed";
    publish();
  }
  return receipt;
}

async function proveCoolingForQualification() {
  if (maybeConfiguration?.noiseQualification) throw new Error("noise_forbids_competing_effect");
  requireWorkerV2ShareMode(maybeConfiguration);
  maybeReviewedContext = undefined;
  if (running) throw new Error("cooling_qualification_admission");
  deviceBaselineConfirmed = false;
  deviceRestorationConfirmed = false;
  publish();
  const report = await controller().qualificationCooling("prove_fan");
  publish();
  return report;
}
async function restoreCoolingBaseline() {
  if (maybeConfiguration?.noiseQualification) throw new Error("noise_forbids_competing_effect");
  requireWorkerV2ShareMode(maybeConfiguration);
  maybeReviewedContext = undefined;
  if (running) throw new Error("cooling_qualification_admission");
  const report = await controller().qualificationCooling("restore_baseline");
  publish();
  return report;
}

async function submitCoolingReview() {
  if (maybeConfiguration?.noiseQualification) throw new Error("noise_forbids_competing_effect");
  requireWorkerV2ShareMode(maybeConfiguration);
  maybeReviewedContext = undefined;
  if (running) throw new Error("cooling_qualification_admission");
  try {
    return await submitWorkerCoolingReview({
      local: localJson, possess: () => controller().prepareWorkerLeaseAuthorizationContext("start"),
      attemptBudget: () => controller().qualificationAttemptReview(), budget: reviewBudget, proveFan: proveCoolingForQualification, restoreFan: restoreCoolingBaseline, state,
    });
  } finally { maybeReviewedContext = undefined; }
}

async function reviewQualificationAttempts() {
  maybeReviewedContext = undefined;
  await controller().prepareWorkerLeaseAuthorizationContext("start");
  return controller().qualificationAttemptReview();
}
async function exportDiagnostics() {
  const body = parseWorkerDiagnosticExport({ schema: "worker-diagnostic-export-v1", observations: localDiagnostics.values() });
  const receipt = await localJson("/diagnostic-export", body);
  if (!receipt || Object.keys(receipt).length !== 2 || receipt.diagnostic_export_saved !== true || typeof receipt.review_file !== "string" || !/^diagnostic-export-[A-Za-z0-9_-]+\.json$/u.test(receipt.review_file)) throw new Error("diagnostic_export_receipt");
  return { diagnostic_export_saved: true, review_file: receipt.review_file };
}

async function submitAttemptCompletion() {
  maybeReviewedContext = undefined;
  if (running || !deviceRestorationConfirmed || !deviceLeaseInactive) throw new Error("completion_admission");
  const input = await localJson("/completion-context", {});
  if (!input || Object.keys(input).length !== 2 || typeof input.nonce !== "string" || typeof input.campaignId !== "string") throw new Error("completion_context");
  await controller().prepareWorkerLeaseAuthorizationContext("start");
  const ledger_after = await controller().qualificationAttemptReview();
  const original_budget = await reviewBudget(input.campaignId);
  await close();
  if (maybeConfiguration?.recoveryPhase || cadence.enabled) await flushRecoverySupervisor();
  const receipt = await localJson("/completion-review", { nonce: input.nonce, ledger_after, original_budget, final_state: state() });
  if (!receipt || !["passed", "unverified"].includes(receipt.result) || !["diagnostic", "normal", "foreground_loss", "heartbeat_loss"].includes(receipt.purpose) || !Number.isSafeInteger(receipt.ordinal) || receipt.ordinal < 1 || receipt.ordinal > 0xffffffff || !Number.isSafeInteger(receipt.cumulative_charged_ms) || receipt.cumulative_charged_ms < 0 || receipt.cleanup_confirmed !== true) throw new Error("completion_receipt");
  if (maybeConfiguration?.recoveryPhase === "loss" && receipt.result === "passed") recoveryLoss.seal();
  return { result: receipt.result, ordinal: receipt.ordinal, purpose: receipt.purpose, cumulative_charged_ms: receipt.cumulative_charged_ms, cleanup_confirmed: true };
}

async function suppressCadenceHeartbeats() {
  if (!cadence.enabled || !running || !maybeWindow) throw new Error("cadence_suppression_admission");
  cadence.requireWindow(maybeWindow.grant);
  requireAcceptanceFaultHeadroom(maybeQualification?.work_gate_remaining_ms);
  cadence.suppress(performance.now(), () => authorizationRecovery.capture(maybeQualification?.generation));
  stopTimer();
  hook.suppressHeartbeats = true;
  publish();
}

export const workerAcceptance = {
  ...createWorkerV2PageOperations({ maybeReviewedBinding: () => maybeReviewedContext?.controlSessionBindingSha256, serializeRead, changed: publish, phase: () => maybeConfiguration?.stratumV2Qualification, scope: () => maybeConfiguration?.stratumV2Scope, connected: () => connected, idle: () => connected && !running && !maybeWindow, controller, maybePreservation: () => preservation.maybePublicState() }),
  ...createWorkerNoisePageOperations({ changed: publish, phase: () => maybeConfiguration?.noiseQualification, idle: () => connected && !running && !maybeWindow, controller, maybePreservation: () => preservation.maybePublicState() }),
  ...createWorkerRestartPageOperations({ enabled: () => maybeConfiguration?.restartQualification === true, idle: () => connected && !running && !maybeWindow,
    maybeController: () => maybeController, before: () => { maybeReviewedContext = undefined; status = "restarting"; deviceBaselineConfirmed = false; publish(); },
    succeeded: () => { status = "ready"; publish(); }, failed: () => { connected = false; running = false; stopTimer(); status = "failed"; maybeFailure = "qualification_restart_failed"; publish(); } }),
  ...createWorkerCadencePageOperations({ cadence, controller, running: () => running, loaded: () => maybeWindow !== undefined,
    maybeReviewedBinding: () => maybeReviewedContext?.controlSessionBindingSha256, invalidateAuthorization: () => { maybeReviewedContext = undefined; }, publish, local: localJson }),
  exportBrowserSerialTrace: () => parseBrowserSerialTrace(browserTrace.snapshot()),
  deviceSerialTraceReview: async () => {
    if (running || maybeWindow) throw new Error("trace_review_admission");
    maybeReviewedContext = undefined;
    return reviewDeviceSerialTrace(controller());
  },
  interruptPendingStatusForQualification,
  submitAttemptCompletion,
  reviewQualificationAttempts,
  exportDiagnostics,
  submitCoolingReview,
  proveCoolingForQualification,
  restoreCoolingBaseline,
  submitBudgetReview,
  rejectStartForRecoveryTest,
  reviewBudget,
  configure,
  connect,
  prepareStartAuthorization,
  loadWindow,
  loadSignedWindow,
  startWindow,
  stop,
  close,
  refresh: () => maybeConfiguration?.stratumV2Qualification ? serializeRead(refresh) : refresh(),
  probe,
  suppressHeartbeats,
  armForegroundLoss,
  state,
};
Object.assign(window, { workerAcceptance });
for (const [id, action] of [
  ["connect", connect],
  ["prepare", prepareStartAuthorization],
  ["start", startWindow],
  ["load", loadSignedWindow],
  ["stop", stop],
  ["close", close],
  ["probe", probe],
  ["suppress", suppressHeartbeats],
  ["arm-foreground", armForegroundLoss],
] as const) {
  document.getElementById(id)?.addEventListener("click", () => {
    Promise.resolve()
      .then(action)
      .catch(() => fail(`${id.replaceAll("-", "_")}_failed`));
  });
}
for (const [id, load] of [["configuration", configure]] as const) {
  document.getElementById(id)?.addEventListener("change", (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    void file
      .text()
      .then((text) => load(JSON.parse(text)))
      .catch(() => fail("local_input_invalid"));
  });
}
publish();

void localJson("/context")
  .then(configure)
  .catch(() => fail("configuration_failed"));
