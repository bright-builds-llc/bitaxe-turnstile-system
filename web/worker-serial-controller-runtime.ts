import { requestWorkerSerialCommand } from "./worker-serial-command";
import { WorkerV2SerialControl } from "./worker-v2-serial-control";
import { isWorkerV2Stratum } from "./worker-v2-stratum";
import type { ChannelStart, V2Scope } from "./worker-v2-serial";
import { validateWorkerSerialControllerInput } from "./worker-serial-controller-input";
import { WorkerNoiseDiagnosticControl } from "./worker-noise-diagnostic-control";
import { parseNoiseStatusV2, type NoiseStartInputV2 } from "./worker-noise-diagnostic";
import { admitWorkerSerialSession } from "./worker-serial-admission";
import { WorkerSerialRestart } from "./worker-serial-restart";
import type { WorkerSerialRestartObserver } from "./worker-serial-restart-observer";
import type { WorkerQualificationRestartRequest } from "./worker-qualification-restart";
import { sendWorkerSerialControl } from "./worker-serial-send";
import type { WorkerCadencePhase } from "./worker-telemetry-cadence";
import { WorkerTelemetryCadenceControl } from "./worker-telemetry-cadence-control";
import { runQualificationCooling, type QualificationCoolingAction } from "./worker-qualification-cooling";
import { WorkerReadInterruptionOwner } from "./worker-read-interruption";
import { WorkerBrowserSerialTrace, type WorkerBrowserSerialTraceEpoch } from "./worker-browser-serial-trace";
import { WorkerMiningInterruptionOwner } from "./worker-mining-interruption";
import { parseBrowserSerialTrace, parseDeviceSerialTrace } from "./worker-serial-trace-export";
import { finishWorkerSerialClose } from "./worker-serial-close";
import { runWorkerSerialExchange } from "./worker-serial-exchange";
import { isWorkerRestorationPending } from "./worker-control-rejection";
import { rejectedStartGrant, runRejectedStart } from "./worker-rejected-start";
import type { WorkLeaseAuthorityTrust, WorkerLeaseAuthorizationOperation } from "./worker-lease-authorization";
import { parseBudgetCampaignId, parseWorkerBudgetReview } from "./worker-budget-review";
import { workerSerialFailureCategory } from "./worker-serial-errors";
import { maybeWorkerDiagnosticPayload } from "./worker-serial-diagnostics";
import type { WorkerSerialHelloExchange } from "./worker-serial-hello";
import { WorkerSerialPortOwner } from "./worker-serial-port-owner";
import { publicWorkerSerialStatus } from "./worker-serial-status";
import { observeWorkerSerialProbe } from "./worker-serial-probe";
import { proveWorkerSerialPossession } from "./worker-serial-possession";
import {
  createWorkerContinuityAccess,
  createMemoryWorkerContinuityAccess,
  type WorkerContinuityAccess,
} from "./worker-continuity-store";
import { type VerifiedWorkerPossession } from "./worker-possession";
import {
  WORKER_CONTROLLER_PROTOCOL_VERSION,
  parseWorkerLeaseGrant, parseWorkerLeaseRenewal, parseWorkerQualificationLedger, parseWorkerRestorationReason,
  type WorkerControllerCapabilities, type WorkerControllerStatus, type WorkerControllerDisconnectReason,
  type WorkerRestorationReason, type WorkerLeaseGrant, type WorkerLeaseRenewal,
} from "./worker-controller";
import { workerMiningStatusMatches, workerRestoredStatusMatches } from "./worker-postconditions";
import {
  WorkerSerialPeer, exactSerialRecord, serialFailure, serialFailureFor,
  type WorkerSerialEnvelope,
} from "./worker-serial";
import { WorkerSerialChannel, type WorkerSerialBrowserRuntime } from "./webserial-worker-port";
import {
  type WorkerSerialQualificationHook, type WebSerialWorkerControllerInput, type WebSerialWorkerController,
  type Ack, type PendingResponse,
} from "./worker-serial-controller.types";
export class BrowserSerialController implements WebSerialWorkerController {
  readonly #restart = new WorkerSerialRestart();
  readonly #readInterruption = new WorkerReadInterruptionOwner();
  readonly #miningInterruption = new WorkerMiningInterruptionOwner();
  readonly #trace: WorkerBrowserSerialTrace;
  #maybeTraceEpoch: WorkerBrowserSerialTraceEpoch | undefined;
  #traceRequestOrdinal = 0;
  #continuity: WorkerContinuityAccess;
  readonly #listeners = new Set<(reason: WorkerControllerDisconnectReason) => Promise<void>>();
  #maybeChannel: WorkerSerialChannel | undefined;
  #maybePeer: WorkerSerialPeer | undefined;
  #maybeAck: Ack | undefined;
  #maybeCapabilities: WorkerControllerCapabilities | undefined;
  #maybePossession: VerifiedWorkerPossession | undefined;
  #maybeDeviceKeySha256: string | undefined;
  #maybePending: PendingResponse | undefined;
  #maybeHello: WorkerSerialHelloExchange | undefined;
  #maybeOwner: WorkerSerialPortOwner | undefined;
  #maybeStopTimer: (() => void) | undefined;
  #maybeUnsubscribe: (() => void) | undefined;
  #maybeClosing: Promise<void> | undefined;
  #state: "unconnected" | "admitting" | "ready" | "restarting" | "closing" | "closed" =
    "unconnected";
  #challengeBinding = "";
  #maybeFingerprint: string | undefined;
  #requestSequence = 0;
  #activeLease = false;
  #heartbeatAdmitted = false;
  #lastHeartbeatSent = 0;
  #lastPossessionAt = -Infinity;
  #generation = 0;
  #admission = 0;
  #maybeFailure: Error | undefined;
  constructor(
    readonly input: WebSerialWorkerControllerInput,
    readonly runtime: WorkerSerialBrowserRuntime,
    readonly maybeContinuity?: WorkerContinuityAccess,
    readonly maybeQualificationHook?: WorkerSerialQualificationHook,
  ) {
    this.#trace = maybeQualificationHook?.maybeTraceHistory ?? new WorkerBrowserSerialTrace(() => runtime.now());
    this.#continuity =
      maybeContinuity ??
      (maybeQualificationHook?.memoryOnlyContinuity
        ? createMemoryWorkerContinuityAccess(input.continuityScope)
        : createWorkerContinuityAccess(input.continuityScope));
    validateWorkerSerialControllerInput(input);
  }
  async requestPermission() {
    if (!this.runtime.userActivation() || !this.runtime.foreground())
      throw serialFailure("foreground_permission");
    if (!["unconnected", "closed"].includes(this.#state))
      throw serialFailure("already_active");
    if (this.#maybeOwner && !this.#maybeOwner.released) throw serialFailure("cleanup_pending");
    this.#state = "admitting";
    this.#miningInterruption.clear();
    this.#maybeTraceEpoch = this.#trace.beginEpoch();
    this.maybeQualificationHook?.observeStatus?.(undefined);
    this.#generation += 1;
    this.#maybeClosing = undefined;
    this.#maybeFailure = undefined;
    const generation = this.#generation;
    const admission = ++this.#admission;
    // requestPort must be called in the original user-activation task.
    const selection = this.runtime.serial.requestPort({ filters: [this.input.deviceFilter] })
      .then(port => ({ port }), () => ({ port: undefined }));
    let maybeOwner: WorkerSerialPortOwner | undefined;
    let stage: import("./worker-serial-controller.types").WorkerSerialAdmissionStage = "ownership";
    try {
      const release = await this.runtime.acquireLock();
      this.maybeQualificationHook?.maybeObserveSerialOwnership?.(false);
      maybeOwner = new WorkerSerialPortOwner(() => {
        release();
        this.maybeQualificationHook?.maybeObserveSerialOwnership?.(true);
      }, this.runtime.maybeAfter);
      this.#maybeOwner = maybeOwner;
      stage = "permission";
      const { port } = await selection;
      if (!port) throw serialFailure("permission_cancelled");
      if (!this.runtime.foreground() || generation !== this.#generation)
        throw serialFailure("foreground_lost");
      stage = "device_filter";
      const info = port.getInfo();
      if (
        info.usbVendorId !== this.input.deviceFilter.usbVendorId ||
        info.usbProductId !== this.input.deviceFilter.usbProductId
      )
        throw serialFailure("selected_port");
      stage = "scope";
      if (this.maybeQualificationHook?.prepareScope) {
        const scope = await this.maybeQualificationHook.prepareScope();
        this.input.continuityScope = scope;
        this.#continuity =
          this.maybeContinuity ??
          (this.maybeQualificationHook?.memoryOnlyContinuity
            ? createMemoryWorkerContinuityAccess(scope)
            : createWorkerContinuityAccess(scope));
      }
      [this.#challengeBinding, this.#maybeFingerprint] = await Promise.all([
        this.#continuity.challengeBindingSha256(),
        this.#continuity.maybeExpectedFingerprint(),
      ]);
      if (!this.runtime.foreground() || generation !== this.#generation)
        throw serialFailure("foreground_lost");
      stage = "opening";
      await maybeOwner.open(port);
      if (!this.runtime.foreground() || generation !== this.#generation) throw serialFailure("foreground_lost");
      stage = "hello";
      this.#maybeChannel = new WorkerSerialChannel(
        port,
        (frame) => this.#receive(frame),
        (error) => this.#lost(error),
        this.maybeQualificationHook?.maybeObserveDiagnostic,
        this.#maybeTraceEpoch,
      );
      maybeOwner.attach(this.#maybeChannel);
      this.#maybeUnsubscribe = this.runtime.subscribeForegroundLoss(() =>
        this.#lost(serialFailure("foreground_lost")),
      );
      return await this.#admitSession(generation, value => { stage = value; });
    } catch (error) {
      if (admission === this.#admission) {
        this.maybeQualificationHook?.maybeObserveAdmissionFailure?.(stage);
        this.maybeQualificationHook?.maybeObserveSerialFailure?.(workerSerialFailureCategory(error));
      }
      try {
        if (generation === this.#generation) await this.#cleanup();
        else if (maybeOwner) await maybeOwner.close();
      } catch {
        if (admission === this.#admission) this.maybeQualificationHook?.maybeObserveAdmissionFailure?.("cleanup");
        throw serialFailure("cleanup_pending");
      }
      throw serialFailure("admission_failed");
    }
  }
  async #admitSession(generation: number, stage: (value: import("./worker-serial-controller.types").WorkerSerialAdmissionStage) => void) {
    const channel = this.#maybeChannel; if (!channel) throw serialFailure("channel_missing");
    return admitWorkerSerialSession({ channel, trustedUpdateKeys: this.input.trustedUpdateKeys, now: () => this.runtime.now(), stage,
      current: () => this.runtime.foreground() && generation === this.#generation && this.#state === "admitting" && this.#maybePeer?.expired(this.runtime.now()) === false,
      hello: value => { this.#maybeHello = value; }, acknowledged: (ack, began) => { this.#restart.freshAck(ack); this.#maybeAck = ack; this.#maybePeer = new WorkerSerialPeer(ack.sessionId, began); channel.admitReceiveCredit(); },
      recovery: value => this.maybeQualificationHook?.maybeObserveHelloRecovery?.(value),
      timer: () => { this.#maybeStopTimer = this.runtime.every(100, () => this.#tick()); }, discover: () => this.#request("discover", undefined, true),
      capability: value => { this.#maybeCapabilities = value; }, prove: async () => { this.#maybePossession = await this.#prove(); },
      heartbeat: async () => { this.#heartbeatAdmitted = true; await this.#heartbeat(); }, baseline: () => this.#statusRequest("status", undefined, true),
      establish: async () => {
        if (!this.#maybePossession) throw serialFailure("possession_missing");
        await this.#continuity.establish(this.#maybePossession.deviceIdentityFingerprint);
        if (generation !== this.#generation || this.#state !== "admitting" || !this.runtime.foreground() || this.#maybePeer?.expired(this.runtime.now()) !== false) throw serialFailure("admission_lost");
        const recovered = this.#maybeFingerprint !== undefined; this.#maybeFingerprint = this.#maybePossession.deviceIdentityFingerprint;
        this.#state = "ready"; return { status: "ready", recovered };
      },
    });
  }
  async #prove(): Promise<VerifiedWorkerPossession> {
    const ack = this.#maybeAck;
    const capabilities = this.#maybeCapabilities;
    if (!ack || !capabilities) throw serialFailure("admission_incomplete");
    const verified = await proveWorkerSerialPossession({
      ack,
      capabilities,
      requestId: `pos_browser_${++this.#requestSequence}`,
      challengeBindingSha256: this.#challengeBinding,
      maybeFingerprint: this.#maybeFingerprint,
      expected: this.input,
      exchange: (request) => this.#exchange(request),
    });
    this.#maybeDeviceKeySha256 = verified.deviceIdentityKeySha256;
    this.#lastPossessionAt = this.runtime.now();
    return verified;
  }

  async discover() {
    this.#requireReady();
    const capability = this.#maybeCapabilities;
    if (!capability) throw serialFailure("capability_missing");
    return structuredClone(capability);
  }
  async prepareWorkerLeaseAuthorizationContext(
    operation: WorkerLeaseAuthorizationOperation,
  ) {
    this.#requireReady();
    if (operation === "start") {
      if (this.#activeLease) throw serialFailure("lease_active");
      try {
        this.#maybePossession = await this.#prove();
      } catch {
        this.#lost(serialFailure("possession_failed"));
        throw serialFailure("possession_failed");
      }
    } else if (operation !== "renew" || !this.#activeLease)
      throw serialFailure("lease_inactive");
    if (!this.#maybePossession) throw serialFailure("possession_missing");
    return {
      controlSessionBindingSha256:
        this.#maybePossession.controlSessionBindingSha256,
    };
  }
  async startLease(input: WorkerLeaseGrant) {
    this.#requireReady();
    if (this.#activeLease || !this.#maybePossession || this.#diagnosticFenced)
      throw serialFailure("lease_state");
    const grant = parseWorkerLeaseGrant(input);
    const maybeV2 = this.maybeQualificationHook?.stratumV2Pair;
    if (isWorkerV2Stratum(grant.stratum)) {
      if (!maybeV2 || maybeV2.scope !== "share" || !grant.qualificationAttempt || grant.qualificationAttempt.purpose !== "normal") throw serialFailure("v2_pair_admission");
      this.#v2.admitShare(grant.qualificationAttempt.id, this.#maybePossession.controlSessionBindingSha256);
    } else if (maybeV2) throw serialFailure("v2_profile_required");
    if (grant.challengeId !== this.input.continuityScope.challengeId)
      throw serialFailure("challenge_binding");
    const result = await this.#statusRequest("start_lease", grant);
    if (!workerMiningStatusMatches(result, grant)) {
      this.#lost(serialFailure("start_postcondition"));
      throw serialFailure("start_postcondition");
    }
    this.#activeLease = true;
    if (isWorkerV2Stratum(grant.stratum)) this.#v2.shareActivated();
    return result;
  }
  async renewLease(input: WorkerLeaseRenewal) {
    this.#requireReady();
    if (!this.#activeLease) throw serialFailure("lease_inactive");
    const renewal = parseWorkerLeaseRenewal(input);
    const result = await this.#statusRequest("renew_lease", renewal);
    if (
      !workerMiningStatusMatches(result, {
        ...renewal,
        challengeId: this.input.continuityScope.challengeId,
      })
    ) {
      this.#lost(serialFailure("renew_postcondition"));
      throw serialFailure("renew_postcondition");
    }
    return result;
  }
  async rejectStartForRecoveryTest(trust: WorkLeaseAuthorityTrust): Promise<{ rejected: true; error: "authentication_failed" }> {
    this.#requireReady();
    if (!this.maybeQualificationHook || this.#activeLease || this.#diagnosticFenced) throw serialFailure("probe_admission");
    const context = await this.prepareWorkerLeaseAuthorizationContext("start");
    const grant = await rejectedStartGrant(this.input.continuityScope.challengeId, context.controlSessionBindingSha256, trust);
    return runRejectedStart(grant, `serial_browser_${++this.#requestSequence}`, request => this.#exchange(request), async () => {
      this.#maybeFailure ??= serialFailure("command_rejected");
      await this.close("control_failed");
    });
  }
  async qualificationCooling(action: QualificationCoolingAction) {
    this.#requireReady();
    if (!this.maybeQualificationHook || this.#activeLease || this.#diagnosticFenced) throw serialFailure("probe_admission");
    return runQualificationCooling(action, {
      prove: () => this.prepareWorkerLeaseAuthorizationContext("start"), request: value => this.#request("qualification_cooling", { action: value }),
      invalidate: possession => { if (possession) this.#maybePossession = undefined; this.maybeQualificationHook?.observeStatus?.(undefined); }, status: () => this.status(), failed: error => this.#lost(error),
    });
  }
  async qualificationAttemptReview() {
    this.#requireReady();
    if (this.#activeLease || !this.#maybePossession) throw serialFailure("probe_admission");
    return parseWorkerQualificationLedger(await this.#request("qualification_attempt_review", {}));
  }
  async interruptPendingStatusForQualification() {
    const generation = this.#generation;
    return this.#readInterruption.run({
      admitted: Boolean(this.maybeQualificationHook && !this.#diagnosticFenced && !this.#activeLease && !this.#maybePending && this.#maybePossession && !this.#maybeChannel?.unfinishedRecord),
      check: () => {
        this.#requireReady(true);
        if (generation !== this.#generation || this.#activeLease || this.#diagnosticFenced) throw serialFailure("probe_admission");
      },
      baseline: () => this.#statusRequest("status", undefined, true),
      request: afterConsumed => this.#request("status", undefined, true, afterConsumed),
      close: () => this.close("cancelled"),
      released: () => this.#maybeOwner?.released === true,
      observation: () => {
        if (!this.#maybeTraceEpoch) throw serialFailure("probe_admission");
        return this.#maybeTraceEpoch.boundary();
      },
    });
  }
  exportBrowserSerialTrace() { return parseBrowserSerialTrace(this.#trace.snapshot()); }
  async deviceSerialTraceReview() {
    this.#requireReady();
    if (this.#activeLease || !this.#maybePossession) throw serialFailure("probe_admission");
    return parseDeviceSerialTrace(await this.#request("serial_trace_review", {}));
  }
  get #diagnosticFenced() { return this.#noise.fenced || this.#v2.fenced; }
  readonly #v2 = new WorkerV2SerialControl({
    requireScope: (scope, effect) => {
      this.#requireReady();
      const maybePair = this.maybeQualificationHook?.stratumV2Pair;
      if (!maybePair || maybePair.scope !== scope || maybePair.firmwareSourceCommit !== this.input.expectedFirmwareSourceCommit || maybePair.appElfSha256 !== this.input.expectedAppElfSha256 || this.#maybePending || (scope === "channel" && this.#activeLease) || (effect && (this.#activeLease || this.#noise.fenced))) throw serialFailure("v2_pair_admission");
    },
    maybeBinding: () => this.#maybePossession?.controlSessionBindingSha256,
    possessionFresh: () => this.runtime.now() >= this.#lastPossessionAt && this.runtime.now() - this.#lastPossessionAt < 60_000,
    request: (command, payload) => this.#request(command, payload),
  });
  stratumV2ChannelStart(input: ChannelStart, binding: string) { return this.#v2.start(input, binding); }
  stratumV2Status(scope: V2Scope, attemptIdOrNull: string | null, binding: string) { return this.#v2.status(scope, attemptIdOrNull, binding); }
  stratumV2ChannelCancel(attemptId: string, binding: string) { return this.#v2.cancel(attemptId, binding); }
  readonly #noise = new WorkerNoiseDiagnosticControl({
    requireIdle: () => {
      this.#requireReady();
      const maybePair = this.maybeQualificationHook?.noiseDiagnosticPair;
      if (!maybePair || maybePair.firmwareSourceCommit !== this.input.expectedFirmwareSourceCommit || maybePair.appElfSha256 !== this.input.expectedAppElfSha256 || this.#activeLease || this.#maybePending) throw serialFailure("noise_pair_admission");
    },
    maybeBinding: () => this.#maybePossession?.controlSessionBindingSha256,
    possessionFresh: () => this.runtime.now() >= this.#lastPossessionAt && this.runtime.now() - this.#lastPossessionAt < 60_000,
    request: (command, payload) => this.#request(command, payload),
  }, "v2");
  async noiseDiagnosticStart(input: NoiseStartInputV2, expectedBinding: string) { return parseNoiseStatusV2(await this.#noise.start(input, expectedBinding)); }
  async noiseDiagnosticStatus(attemptIdOrNull: string | null, expectedBinding: string) { return parseNoiseStatusV2(await this.#noise.status(attemptIdOrNull, expectedBinding)); }
  async noiseDiagnosticCancel(attemptId: string, expectedBinding: string) { return parseNoiseStatusV2(await this.#noise.cancel(attemptId, expectedBinding)); }
  readonly #cadence = new WorkerTelemetryCadenceControl({
    requireIdle: () => {
      this.#requireReady(); // Normal heartbeats may be serializing; the writer already bounds their completion.
      if (!this.maybeQualificationHook || this.#activeLease || this.#maybePending || this.#diagnosticFenced) throw serialFailure("probe_admission");
    },
    prove: () => this.prepareWorkerLeaseAuthorizationContext("start"), request: (command, payload) => this.#request(command, payload),
    maybeBinding: () => this.#maybePossession?.controlSessionBindingSha256,
    possessionFresh: () => this.runtime.now() >= this.#lastPossessionAt && this.runtime.now() - this.#lastPossessionAt <= 5000,
  });
  telemetryCadenceArm(phase: WorkerCadencePhase) { return this.#cadence.arm(phase); }
  telemetryCadenceReview() { return this.#cadence.review(); }
  telemetryCadenceEndpoint(maybeBinding?: string) { return this.#cadence.endpoint(maybeBinding); }
  qualificationRestartSummary() { return this.#restart.observer?.summary(); }
  qualificationRestartEvidence() { return this.#restart.evidence(); }
  qualificationRestart(input: WorkerQualificationRestartRequest) {
    return this.#restart.run(input, {
      ready: () => { this.#requireReady(); if (!this.maybeQualificationHook?.allowQualificationRestart || this.#activeLease || this.#maybePending || this.#diagnosticFenced) throw serialFailure("probe_admission"); },
      identity: () => { if (!this.#maybeAck) throw serialFailure("admission_incomplete"); return this.#maybeAck; }, now: () => this.runtime.now(), maybeAfter: this.runtime.maybeAfter,
      prearm: observer => { this.#maybeChannel?.observeExpectedRestart(observer); },
      prepare: async () => { this.#maybePossession = await this.#prove(); const status = await this.#statusRequest("status", undefined, true); if (status.state !== "baseline" || !["confirmed", "not_required"].includes(status.restoration.status)) throw serialFailure("baseline_unconfirmed"); },
      freezeWrites: async () => { this.#state = "restarting"; this.#heartbeatAdmitted = false; await this.#heartbeat(); await this.#maybeChannel?.settleWrites(); },
      request: request => this.#request("qualification_restart", request, true),
      acknowledged: () => { this.#heartbeatAdmitted = false; this.#maybeStopTimer?.(); this.#maybeStopTimer = undefined; this.#maybePeer?.revoke(); this.#maybePossession = undefined; this.#maybeAck = undefined; },
      reopen: observer => this.#reopenRestart(observer),
      fresh: async observer => { if (!this.#maybeChannel) throw serialFailure("channel_missing"); await this.#maybeChannel.beginRestartSession(); this.#maybeTraceEpoch = this.#trace.beginEpoch(); this.#maybeChannel.traceEpoch(this.#maybeTraceEpoch); observer.helloStarted(); this.#generation++; this.#state = "admitting"; await this.#admitSession(this.#generation, () => {}); observer.check(); },
      finish: () => { this.#maybeChannel?.observeExpectedRestart(undefined); }, cleanup: () => this.#cleanup(),
    });
  }
  async #reopenRestart(observer: WorkerSerialRestartObserver) {
    if (!this.#maybeOwner) throw serialFailure("ownership"); observer.requireReopen();
    this.#generation++; this.#heartbeatAdmitted = false; this.#maybeStopTimer?.(); this.#maybeStopTimer = undefined;
    this.#maybeHello?.reject(observer.interruptionError); this.#maybePending?.reject(observer.interruptionError);
    this.#maybeHello = undefined; this.#maybePending = undefined; this.#maybePeer = undefined; this.#maybeAck = undefined; this.#maybePossession = undefined;
    const port = await this.#maybeOwner.reopenExpectedReset(() => { observer.remaining(); if (!this.runtime.foreground() || !observer.active) throw serialFailure("foreground_lost"); }); observer.reopened();
    const channel = new WorkerSerialChannel(port, frame => this.#receive(frame), error => this.#lost(error), this.maybeQualificationHook?.maybeObserveDiagnostic, this.#maybeTraceEpoch);
    channel.observeExpectedRestart(observer); this.#maybeChannel = channel; this.#maybeOwner.attach(channel);
  }
  async qualificationAbruptDisconnect() {
    this.#requireReady();
    return this.#miningInterruption.interrupt(this.runtime.now(), Boolean(this.maybeQualificationHook && this.#activeLease && !this.#maybePending && !this.#maybeChannel?.unfinishedRecord), async () => {
      this.#heartbeatAdmitted = false;
      this.#maybePeer?.revoke();
      this.#maybeChannel?.abortRecord();
      this.#maybeFailure ??= serialFailure("closed");
      await this.close("cancelled");
    }, () => this.#maybeOwner?.released === true);
  }
  async acceptanceBudgetReview(campaignId: string) {
    this.#requireReady();
    if (this.#activeLease || !this.#maybePossession) throw serialFailure("probe_admission");
    return parseWorkerBudgetReview(await this.#request("acceptance_budget_review", { campaignId: parseBudgetCampaignId(campaignId) }));
  }
  async transportProbe(maybePaddingBytes?: number) {
    this.#requireReady();
    if (this.#activeLease || !this.#maybePossession || this.#diagnosticFenced)
      throw serialFailure("probe_admission");
    return observeWorkerSerialProbe(`serial_browser_${this.#requestSequence + 1}`, maybePaddingBytes,
      payload => this.#request("transport_probe", payload), error => this.#lost(error));
  }

  async status() { return this.#statusRequest("status"); }
  async pause() { return this.#restoreCommand("pause", "paused"); }
  async cancel() {
    const result = await this.#restoreCommand("cancel", "cancelled");
    await this.#continuity.clear();
    return result;
  }
  async restore(reason: WorkerRestorationReason) {
    return this.#restoreCommand("restore", parseWorkerRestorationReason(reason));
  }
  async #statusRequest(
    command: string,
    maybePayload?: unknown,
    closing = false,
  ): Promise<WorkerControllerStatus> {
    if (!closing) this.#requireReady();
    const generation = this.#generation;
    try {
      const status = publicWorkerSerialStatus(
        await this.#request(command, maybePayload, closing),
        this.#maybeDeviceKeySha256,
        this.maybeQualificationHook?.observePreservation,
        this.maybeQualificationHook?.observeStatus,
      );
      this.#miningInterruption.observe(status, this.runtime.now());
      return status;
    } catch (error) {
      if (this.#diagnosticFenced && isWorkerRestorationPending(error)) throw error;
      const failure = serialFailureFor(error, "request_failed");
      if (generation === this.#generation || !this.#restart.active) this.#lost(failure);
      throw failure;
    }
  }
  async #restoreCommand(command: string, reason: WorkerRestorationReason, closing = false) {
    const status = await this.#statusRequest(
      command,
      command === "restore" ? { reason } : undefined,
      closing,
    );
    if (!workerRestoredStatusMatches(status, reason)) {
      this.#lost(serialFailure("restoration_unconfirmed"));
      throw serialFailure("restoration_unconfirmed");
    }
    this.#activeLease = false;
    this.#maybePossession = undefined;
    return status;
  }
  subscribeDisconnect(
    listener: (reason: WorkerControllerDisconnectReason) => Promise<void>,
  ) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  async close(reason: WorkerRestorationReason = "tab_closed"): Promise<void> {
    this.#restart.fail(serialFailure("closed"));
    if (this.#maybeClosing) return this.#maybeClosing;
    if (this.#state === "closed" || this.#state === "unconnected") return;
    this.#state = "closing";
    this.#generation += 1;
    this.#maybeClosing = this.#finishClose(reason);
    return this.#maybeClosing;
  }
  async #finishClose(reason: WorkerRestorationReason) {
    const interrupted = this.#maybeChannel?.unfinishedRecord === true || this.#maybePending !== undefined;
    await finishWorkerSerialClose({
      interrupted,
      restore: Boolean(this.#activeLease && !interrupted && !this.#maybeFailure && !this.maybeQualificationHook?.suppressHeartbeats),
      closeSession: () => Boolean(!interrupted && !this.#maybeFailure && this.#maybeChannel && this.#maybeAck),
      revokeRecord: () => { this.#heartbeatAdmitted = false; this.#maybeChannel?.abortRecord(); },
      restoreBaseline: () => this.#restoreCommand("restore", reason, true), stopHeartbeats: () => { this.#heartbeatAdmitted = false; },
      sendClose: () => this.#send("session", { op: "close", reason }), cleanup: () => this.#cleanup(),
    });
  }
  #requireReady(qualificationRead = false) {
    if (this.#restart.active) throw serialFailure("operation_active");
    if (this.#readInterruption.active && !qualificationRead) throw serialFailure("operation_active");
    if (
      this.#state !== "ready" ||
      !this.runtime.foreground() ||
      this.#maybePeer?.expired(this.runtime.now())
    )
      throw this.#maybeFailure ?? serialFailure("not_ready");
  }
  #tick() {
    if (
      !this.runtime.foreground() ||
      this.#maybePeer?.expired(this.runtime.now())
    ) {
      this.#lost(serialFailure("liveness_lost"));
      return;
    }
    if (
      this.#heartbeatAdmitted &&
      !this.maybeQualificationHook?.suppressHeartbeats &&
      this.runtime.now() - this.#lastHeartbeatSent >= 1_000
    )
      void this.#heartbeat().catch((error: Error) => this.#lost(error));
  }
  async #heartbeat() {
    this.#lastHeartbeatSent = this.runtime.now();
    await this.#send("heartbeat", {});
  }
  #receive(frame: WorkerSerialEnvelope) {
    if (this.#maybeHello?.receive(frame)) return;
    if (!this.#maybePeer) throw serialFailure("unadmitted_frame");
    this.#maybePeer.receive(frame, this.runtime.now());
    if (frame.kind === "session" && frame.payload.op === "receive_credit") {
      const value = exactSerialRecord(frame.payload, ["op", "receivedBytes"]);
      this.#maybeChannel?.receiveCredit(value.receivedBytes);
      return;
    }
    if (frame.kind === "diagnostic") {
      const maybeDiagnostic = maybeWorkerDiagnosticPayload(frame.payload);
      if (maybeDiagnostic) { this.#restart.observer?.diagnostic(maybeDiagnostic); this.maybeQualificationHook?.maybeObserveDiagnostic?.(maybeDiagnostic); }
      return;
    }
    if (frame.kind === "heartbeat") return;
    const pending = this.#maybePending;
    if (
      frame.kind !== "control" ||
      !pending ||
      frame.payload.requestId !== pending.requestId
    )
      throw serialFailure("correlation");
    this.#restart.acceptResponse(frame.payload);
    this.#maybePending = undefined;
    this.#maybeTraceEpoch?.record("response_delivered");
    pending.resolve(frame.payload);
  }
  #lost(error: Error) {
    if (error === this.#restart.observer?.interruptionError) return;
    this.#restart.fail(error);
    if (["closed", "unconnected"].includes(this.#state)) return;
    this.#heartbeatAdmitted = false;
    this.maybeQualificationHook?.observeStatus?.(undefined);
    this.maybeQualificationHook?.maybeObserveSerialFailure?.(workerSerialFailureCategory(error));
    this.#maybeFailure ??= error;
    this.#maybePeer?.revoke();
    this.#maybePending?.reject(error);
    this.#maybePending = undefined;
    this.#maybeHello?.reject(error);
    this.#maybeHello = undefined;
    if (this.#state === "closing") return;
    void this.close("control_failed").catch((failure: Error) => {
      this.#maybeFailure ??= failure;
    });
    for (const listener of this.#listeners)
      void listener("connectivity_lost").catch(() => {
        this.#maybeFailure ??= serialFailure("disconnect_listener");
      });
  }
  async #request(
    command: string,
    maybePayload?: unknown,
    admitting = false,
    maybeAfterConsumed?: (pending: boolean) => Promise<void>,
  ): Promise<unknown> {
    if (!admitting) this.#requireReady();
    if (this.#diagnosticFenced && ["start_lease", "qualification_restart", "qualification_cooling", "telemetry_cadence_arm", "transport_probe"].includes(command)) throw serialFailure("noise_effect_fence");
    return requestWorkerSerialCommand({ command, maybePayload, requestId: `serial_browser_${++this.#requestSequence}`, fenced: this.#diagnosticFenced, maybeHook: this.maybeQualificationHook,
      exchange: (request, timeout) => this.#exchange(request, timeout, maybeAfterConsumed) });
  }
  async #exchange(
    request: { requestId: string } & Record<string, unknown>,
    timeoutMilliseconds = 30_000,
    maybeAfterConsumed?: (pending: boolean) => Promise<void>,
  ): Promise<unknown> {
    if (this.#maybePending) throw serialFailure("operation_active");
    const generation = this.#generation;
    const maybeTraceEpoch = this.#maybeTraceEpoch;
    maybeTraceEpoch?.request(++this.#traceRequestOrdinal);
    const response = new Promise<unknown>((resolve, reject) => {
      this.#maybePending = { requestId: request.requestId, resolve, reject };
    });
    return runWorkerSerialExchange({
      response, send: async () => { await this.#send("control", request); maybeTraceEpoch?.record("request_consumed"); }, timeoutMilliseconds, maybeAfter: this.runtime.maybeAfter,
      maybeAfterConsumed: maybeAfterConsumed ? () => maybeAfterConsumed(this.#maybePending?.requestId === request.requestId) : undefined,
      current: () => generation === this.#generation, failed: error => { if (generation === this.#generation || !this.#restart.active) this.#lost(error); },
      clear: () => { if (this.#maybePending?.requestId === request.requestId) this.#maybePending = undefined; },
    });
  }
  async #send(kind: WorkerSerialEnvelope["kind"], payload: Record<string, unknown>) {
    await sendWorkerSerialControl({ maybeChannel: this.#maybeChannel, maybeSessionId: this.#maybeAck?.sessionId,
      heartbeatAdmitted: this.#heartbeatAdmitted, suppressed: this.maybeQualificationHook?.suppressHeartbeats === true,
      heartbeat: () => this.#heartbeat() }, kind, payload);
  }
  async #cleanup() {
    this.#state = "closed";
    this.#heartbeatAdmitted = false;
    this.#activeLease = false;
    this.#maybeStopTimer?.();
    this.#maybeStopTimer = undefined;
    this.#maybeUnsubscribe?.();
    this.#maybeUnsubscribe = undefined;
    this.#maybePending?.reject(serialFailure("closed"));
    this.#maybePending = undefined;
    this.#maybeHello?.reject(serialFailure("closed"));
    this.#maybeHello = undefined;
    this.#maybeChannel = undefined;
    this.#maybePeer = undefined;
    this.#maybePossession = undefined;
    this.#maybeDeviceKeySha256 = undefined;
    this.#maybeAck = undefined;
    if (this.#maybeOwner) await this.#maybeOwner.close();
  }
}
