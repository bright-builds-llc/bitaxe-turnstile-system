import { publicWorkerSerialStatus } from "./worker-serial-status";
import { probeWorkerSerialTransport } from "./worker-serial-probe";
import { encodeBase64Url } from "./crypto-bytes";
import { proveWorkerSerialPossession } from "./worker-serial-possession";
import {
  createWorkerContinuityAccess,
  createMemoryWorkerContinuityAccess,
  type WorkerContinuityAccess,
} from "./worker-continuity-store";
import { type VerifiedWorkerPossession } from "./worker-possession";
import {
  WORKER_CONTROLLER_PROTOCOL_VERSION,
  parseWorkerControllerCapabilities,
  verifyWorkerControllerCapability,
  parseWorkerLeaseGrant,
  parseWorkerLeaseRenewal,
  parseWorkerRestorationReason,
  type WorkerControllerCapabilities,
  type WorkerControllerStatus,
  type WorkerControllerDisconnectReason,
  type WorkerRestorationReason,
  type WorkerLeaseGrant,
  type WorkerLeaseRenewal,
} from "./worker-controller";
import {
  workerMiningStatusMatches,
  workerRestoredStatusMatches,
} from "./worker-postconditions";
import type { WorkerLeaseAuthorizationOperation } from "./worker-lease-authorization";
import {
  WORKER_SERIAL_PROFILE,
  WorkerSerialPeer,
  exactSerialRecord,
  parseWorkerSerialManifest,
  serialNonce,
  serialFailure,
  type WorkerSerialEnvelope,
} from "./worker-serial";
import {
  WorkerSerialChannel,
  browserSerialRuntime,
  boundedSerial,
  workerSerialTestRuntime,
  type WorkerSerialBrowserRuntime,
} from "./webserial-worker-port";

import {
  workerSerialQualificationHook,
  type WorkerSerialQualificationHook,
  type WorkerSerialInternalOptions,
  type WebSerialWorkerControllerInput,
  type WebSerialWorkerController,
  type Ack,
  type PendingResponse,
} from "./worker-serial-controller.types";
export {
  workerSerialQualificationHook,
  type WorkerSerialQualificationHook,
  type WorkerSerialInternalOptions,
  type WebSerialWorkerControllerInput,
  type WebSerialWorkerController,
} from "./worker-serial-controller.types";

/** Creates the direct foreground-only production adapter; construction performs no port effect. */
export function createWebSerialWorkerController(
  input: WebSerialWorkerControllerInput,
): WebSerialWorkerController {
  const maybeOptions = (
    input as WebSerialWorkerControllerInput & {
      [workerSerialTestRuntime]?: WorkerSerialInternalOptions;
    }
  )[workerSerialTestRuntime];
  return new BrowserSerialController(
    input,
    maybeOptions?.runtime ?? browserSerialRuntime(),
    maybeOptions?.continuity,
    (
      input as WebSerialWorkerControllerInput & {
        [workerSerialQualificationHook]?: WorkerSerialQualificationHook;
      }
    )[workerSerialQualificationHook],
  );
}
class BrowserSerialController implements WebSerialWorkerController {
  #continuity: WorkerContinuityAccess;
  readonly #listeners = new Set<
    (reason: WorkerControllerDisconnectReason) => Promise<void>
  >();
  #maybeChannel: WorkerSerialChannel | undefined;
  #maybePeer: WorkerSerialPeer | undefined;
  #maybeAck: Ack | undefined;
  #maybeCapabilities: WorkerControllerCapabilities | undefined;
  #maybePossession: VerifiedWorkerPossession | undefined;
  #maybeDeviceKeySha256: string | undefined;
  #maybePending: PendingResponse | undefined;
  #maybeHello:
    | { resolve(frame: WorkerSerialEnvelope): void; reject(error: Error): void }
    | undefined;
  #maybeRelease: (() => void) | undefined;
  #maybeStopTimer: (() => void) | undefined;
  #maybeUnsubscribe: (() => void) | undefined;
  #maybeClosing: Promise<void> | undefined;
  #state: "unconnected" | "admitting" | "ready" | "closing" | "closed" =
    "unconnected";
  #challengeBinding = "";
  #maybeFingerprint: string | undefined;
  #requestSequence = 0;
  #activeLease = false;
  #heartbeatAdmitted = false;
  #lastHeartbeatSent = 0;
  #generation = 0;
  #maybeFailure: Error | undefined;
  constructor(
    readonly input: WebSerialWorkerControllerInput,
    readonly runtime: WorkerSerialBrowserRuntime,
    readonly maybeContinuity?: WorkerContinuityAccess,
    readonly maybeQualificationHook?: WorkerSerialQualificationHook,
  ) {
    this.#continuity =
      maybeContinuity ??
      (maybeQualificationHook?.memoryOnlyContinuity
        ? createMemoryWorkerContinuityAccess(input.continuityScope)
        : createWorkerContinuityAccess(input.continuityScope));
    if (
      input.expectedFirmwareSourceCommit !== undefined &&
      !/^[0-9a-f]{40}$/u.test(input.expectedFirmwareSourceCommit)
    )
      throw serialFailure("source_commit");
    if (
      input.expectedAppElfSha256 !== undefined &&
      !/^[0-9a-f]{64}$/u.test(input.expectedAppElfSha256)
    )
      throw serialFailure("elf_hash");
  }
  async requestPermission() {
    if (!this.runtime.userActivation() || !this.runtime.foreground())
      throw serialFailure("foreground_permission");
    if (!["unconnected", "closed"].includes(this.#state))
      throw serialFailure("already_active");
    this.#state = "admitting";
    this.maybeQualificationHook?.observeStatus?.(undefined);
    this.#generation += 1;
    this.#maybeClosing = undefined;
    this.#maybeFailure = undefined;
    const generation = this.#generation;
    // requestPort must be called in the original user-activation task.
    const selection = this.runtime.serial.requestPort({
      filters: [this.input.deviceFilter],
    });
    try {
      this.#maybeRelease = await this.runtime.acquireLock();
      const port = await selection;
      if (!this.runtime.foreground() || generation !== this.#generation)
        throw serialFailure("foreground_lost");
      const info = port.getInfo();
      if (
        info.usbVendorId !== this.input.deviceFilter.usbVendorId ||
        info.usbProductId !== this.input.deviceFilter.usbProductId
      )
        throw serialFailure("selected_port");
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
      await boundedSerial(
        port.open({
          baudRate: 115_200,
          bufferSize: 66_560,
          flowControl: "none",
        }),
        2_000,
      );
      this.#maybeChannel = new WorkerSerialChannel(
        port,
        (frame) => this.#receive(frame),
        (error) => this.#lost(error),
      );
      this.#maybeUnsubscribe = this.runtime.subscribeForegroundLoss(() =>
        this.#lost(serialFailure("foreground_lost")),
      );
      const hostNonce = encodeBase64Url(
        crypto.getRandomValues(new Uint8Array(32)),
      );
      const helloStarted = this.runtime.now();
      const hello = new Promise<WorkerSerialEnvelope>((resolve, reject) => {
        this.#maybeHello = { resolve, reject };
      });
      await this.#maybeChannel.send({
        profile: WORKER_SERIAL_PROFILE,
        kind: "session",
        sessionId: null,
        sequence: 0,
        payload: { op: "hello", hostNonce },
      });
      const frame = await boundedSerial(hello, 2_800);
      this.#maybeHello = undefined;
      const ack = exactSerialRecord(frame.payload, [
        "op",
        "hostNonce",
        "deviceNonce",
        "serialManifest",
        "firmwareSourceCommit",
        "appElfSha256",
      ]);
      if (
        frame.kind !== "session" ||
        frame.sequence !== 0 ||
        !frame.sessionId ||
        ack.op !== "hello_ack" ||
        ack.hostNonce !== hostNonce ||
        !serialNonce(ack.deviceNonce) ||
        typeof ack.firmwareSourceCommit !== "string" ||
        !/^[0-9a-f]{40}$/u.test(ack.firmwareSourceCommit) ||
        typeof ack.appElfSha256 !== "string" ||
        !/^[0-9a-f]{64}$/u.test(ack.appElfSha256)
      )
        throw serialFailure("hello_ack");
      const manifest = parseWorkerSerialManifest(ack.serialManifest);
      this.#maybeAck = {
        sessionId: frame.sessionId,
        hostNonce,
        deviceNonce: ack.deviceNonce,
        firmwareSourceCommit: ack.firmwareSourceCommit,
        appElfSha256: ack.appElfSha256,
      };
      this.#maybePeer = new WorkerSerialPeer(frame.sessionId, helloStarted);
      this.#maybeStopTimer = this.runtime.every(100, () => this.#tick());
      const capabilities = parseWorkerControllerCapabilities(
        await this.#request("discover", undefined, true),
      );
      this.#maybeCapabilities = await verifyWorkerControllerCapability(
        capabilities,
        manifest,
        this.input.trustedUpdateKeys,
      );
      this.#maybePossession = await this.#prove();
      this.#heartbeatAdmitted = true;
      await this.#heartbeat();
      const status = await this.#statusRequest("status", undefined, true);
      if (
        status.state !== "baseline" ||
        !["confirmed", "not_required"].includes(status.restoration.status)
      )
        throw serialFailure("baseline_unconfirmed");
      if (
        !this.runtime.foreground() ||
        generation !== this.#generation ||
        this.#maybePeer.expired(this.runtime.now())
      )
        throw serialFailure("admission_lost");
      await this.#continuity.establish(
        this.#maybePossession.deviceIdentityFingerprint,
      );
      const recovered = this.#maybeFingerprint !== undefined;
      this.#maybeFingerprint = this.#maybePossession.deviceIdentityFingerprint;
      this.#state = "ready";
      return { status: "ready" as const, recovered };
    } catch {
      await this.#cleanup();
      throw serialFailure("admission_failed");
    }
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
    if (this.#activeLease || !this.#maybePossession)
      throw serialFailure("lease_state");
    const grant = parseWorkerLeaseGrant(input);
    if (grant.challengeId !== this.input.continuityScope.challengeId)
      throw serialFailure("challenge_binding");
    const result = await this.#statusRequest("start_lease", grant);
    if (!workerMiningStatusMatches(result, grant)) {
      this.#lost(serialFailure("start_postcondition"));
      throw serialFailure("start_postcondition");
    }
    this.#activeLease = true;
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
  async transportProbe(maybePaddingBytes?: number) {
    this.#requireReady();
    if (this.#activeLease || !this.#maybePossession)
      throw serialFailure("probe_admission");
    try {
      return await probeWorkerSerialTransport(
        `serial_browser_${this.#requestSequence + 1}`,
        maybePaddingBytes,
        (padding) => this.#request("transport_probe", { padding }),
      );
    } catch {
      this.#lost(serialFailure("probe_failed"));
      throw serialFailure("probe_failed");
    }
  }

  async status() {
    return this.#statusRequest("status");
  }
  async pause() {
    return this.#restoreCommand("pause", "paused");
  }
  async cancel() {
    const result = await this.#restoreCommand("cancel", "cancelled");
    await this.#continuity.clear();
    return result;
  }
  async restore(reason: WorkerRestorationReason) {
    return this.#restoreCommand(
      "restore",
      parseWorkerRestorationReason(reason),
    );
  }
  async #statusRequest(
    command: string,
    maybePayload?: unknown,
    closing = false,
  ): Promise<WorkerControllerStatus> {
    try {
      return publicWorkerSerialStatus(
        await this.#request(command, maybePayload, closing),
        this.#maybeDeviceKeySha256,
        this.maybeQualificationHook?.observePreservation,
        this.maybeQualificationHook?.observeStatus,
      );
    } catch {
      this.#lost(serialFailure("status_failed"));
      throw serialFailure("status_failed");
    }
  }
  async #restoreCommand(
    command: string,
    reason: WorkerRestorationReason,
    closing = false,
  ) {
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
    if (this.#maybeClosing) return this.#maybeClosing;
    if (this.#state === "closed" || this.#state === "unconnected") return;
    this.#state = "closing";
    this.#generation += 1;
    this.#maybeClosing = this.#finishClose(reason);
    return this.#maybeClosing;
  }
  async #finishClose(reason: WorkerRestorationReason) {
    let maybeError: unknown;
    try {
      if (
        this.#activeLease &&
        !this.#maybePending &&
        !this.#maybeFailure &&
        !this.maybeQualificationHook?.suppressHeartbeats
      )
        await this.#restoreCommand("restore", reason, true);
      this.#heartbeatAdmitted = false;
      if (this.#maybeChannel && this.#maybeAck)
        await this.#send("session", { op: "close", reason });
    } catch (error) {
      maybeError = error;
    }
    try {
      await this.#cleanup();
    } catch (error) {
      maybeError = maybeError
        ? new AggregateError([maybeError, error], "Worker Serial close failed")
        : error;
    }
    if (maybeError) throw maybeError;
  }
  #requireReady() {
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
    if (this.#maybeHello) {
      this.#maybeHello.resolve(frame);
      return;
    }
    if (!this.#maybePeer) throw serialFailure("unadmitted_frame");
    this.#maybePeer.receive(frame, this.runtime.now());
    if (frame.kind === "heartbeat" || frame.kind === "diagnostic") return;
    const pending = this.#maybePending;
    if (
      frame.kind !== "control" ||
      !pending ||
      frame.payload.requestId !== pending.requestId
    )
      throw serialFailure("correlation");
    this.#maybePending = undefined;
    pending.resolve(frame.payload);
  }
  #lost(error: Error) {
    if (["closed", "unconnected"].includes(this.#state)) return;
    this.#heartbeatAdmitted = false;
    this.maybeQualificationHook?.observeStatus?.(undefined);
    this.#maybeFailure = error;
    this.#maybePeer?.revoke();
    this.#maybePending?.reject(error);
    this.#maybePending = undefined;
    this.#maybeHello?.reject(error);
    this.#maybeHello = undefined;
    if (this.#state === "closing") return;
    void this.close("control_failed").catch((failure: Error) => {
      this.#maybeFailure = failure;
    });
    for (const listener of this.#listeners)
      void listener("connectivity_lost").catch(() => {
        this.#maybeFailure = serialFailure("disconnect_listener");
      });
  }
  async #request(
    command: string,
    maybePayload?: unknown,
    admitting = false,
  ): Promise<unknown> {
    if (!admitting) this.#requireReady();
    if (
      ["start_lease", "renew_lease", "pause", "cancel", "restore"].includes(
        command,
      )
    )
      this.maybeQualificationHook?.observeStatus?.(undefined);
    const response = await this.#exchange(
      {
        protocolVersion: WORKER_CONTROLLER_PROTOCOL_VERSION,
        requestId: `serial_browser_${++this.#requestSequence}`,
        command,
        ...(maybePayload === undefined ? {} : { payload: maybePayload }),
      },
      ["restore", "pause", "cancel"].includes(command) ? 145_000 : 30_000,
    );
    const value = exactSerialRecord(
      response,
      response &&
        typeof response === "object" &&
        "ok" in response &&
        response.ok === true
        ? ["protocolVersion", "requestId", "ok", "result"]
        : ["protocolVersion", "requestId", "ok", "error"],
    );
    if (
      value.protocolVersion !== WORKER_CONTROLLER_PROTOCOL_VERSION ||
      value.ok !== true
    )
      throw serialFailure("command_rejected");
    return value.result;
  }
  async #exchange(
    request: { requestId: string } & Record<string, unknown>,
    timeoutMilliseconds = 30_000,
  ): Promise<unknown> {
    if (this.#maybePending) throw serialFailure("operation_active");
    const generation = this.#generation;
    const response = new Promise<unknown>((resolve, reject) => {
      this.#maybePending = { requestId: request.requestId, resolve, reject };
    });
    try {
      await this.#send("control", request);
      const value = await boundedSerial(
        response,
        timeoutMilliseconds,
        this.runtime.maybeAfter,
      );
      if (generation !== this.#generation)
        throw serialFailure("stale_response");
      return value;
    } catch (error) {
      this.#lost(serialFailure("request_failed"));
      throw error;
    } finally {
      this.#clearPending(request.requestId);
    }
  }
  #clearPending(requestId: string) {
    if (this.#maybePending?.requestId === requestId)
      this.#maybePending = undefined;
  }
  async #send(
    kind: WorkerSerialEnvelope["kind"],
    payload: Record<string, unknown>,
  ) {
    if (!this.#maybeChannel || !this.#maybeAck)
      throw serialFailure("channel_missing");
    await this.#maybeChannel.send({
      profile: WORKER_SERIAL_PROFILE,
      kind,
      sessionId: this.#maybeAck.sessionId,
      sequence: 1,
      payload,
    });
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
    const channel = this.#maybeChannel;
    this.#maybeChannel = undefined;
    this.#maybePeer = undefined;
    this.#maybePossession = undefined;
    this.#maybeDeviceKeySha256 = undefined;
    this.#maybeAck = undefined;
    try {
      if (channel) await channel.close();
    } finally {
      this.#maybeRelease?.();
      this.#maybeRelease = undefined;
    }
  }
}
