import {
  WORKER_CONTROLLER_V03_PROTOCOL_VERSION,
  parseWorkerControllerCapabilitiesV03,
  parseWorkerControllerStatusV03,
  parseWorkerLeaseGrantV03,
  parseWorkerLeaseRenewalV03,
  verifyWorkerControllerCapabilityV03,
  type WorkerControllerCapabilitiesV03,
  type WorkerControllerStatusV03,
  type WorkerControllerV03,
  type WorkerLeaseGrantV03,
  type WorkerLeaseRenewalV03,
} from "./worker-controller-v03";
import {
  MAXIMUM_WORKER_CONTROLLER_USB_FRAME_BYTES,
  assertWorkerControllerUsbCorrelationV03,
  decodeWorkerControllerUsbResponseV03,
  encodeWorkerControllerUsbMessageV03,
  type WorkerControllerUsbRequestV03,
} from "./worker-controller-usb-v03";
import type {
  WorkerControllerDisconnectReason,
  WorkerRestorationReason,
} from "./worker-controller";
import { parseWorkerRestorationReason } from "./worker-controller";
import {
  createWorkerContinuityAccess,
  workerContinuityTestOptions,
  type WorkerContinuityAccess,
  type WorkerContinuityScope,
  type WorkerContinuityTestOptions,
} from "./worker-continuity-store";
import type {
  WorkerLeaseAuthorizationContext,
  WorkerLeaseAuthorizationContextProvider,
  WorkerLeaseAuthorizationOperation,
} from "./worker-lease-authorization";
import type { VerifiedWorkerPossession } from "./worker-possession";
import {
  WorkerWebUsbTransferError,
  assertWorkerWebUsbUserActivation,
  createWorkerWebUsbRuntime,
  releaseAndCloseWorkerWebUsbDevice,
  releaseAndCloseWorkerWebUsbDeviceStrict,
  selectWorkerWebUsbDevice,
  transactWorkerWebUsb,
  workerWebUsbTestOptions,
  type WorkerWebUsbAccess,
  type WorkerWebUsbDevice,
  type WorkerWebUsbDeviceFilter,
  type WorkerWebUsbDisconnectEvent,
  type WorkerWebUsbRuntime,
  type WorkerWebUsbTestOptions,
} from "./webusb-worker-port";
import {
  WorkerWebUsbAuthorizationContext,
  proveWorkerWebUsbPossession,
} from "./webusb-worker-authorization-context";
import {
  isDeviceCommandRejection,
  normalizeAdapterError,
  notifyWorkerDisconnect,
} from "./webusb-worker-adapter-support";
import {
  closeWorkerAfterPostconditionFailure,
  workerMiningStatusMatches,
  workerReacquisitionRestorationMatches,
  workerRestoredStatusMatches,
} from "./webusb-worker-postconditions";
export type {
  WorkerWebUsbAccess,
  WorkerWebUsbDevice,
  WorkerWebUsbDeviceFilter,
  WorkerWebUsbDisconnectEvent,
  WorkerWebUsbTransferInResult,
  WorkerWebUsbTransferOutResult,
} from "./webusb-worker-port";
export type { WorkerContinuityScope } from "./worker-continuity-store";
/** Redacted result distinguishing first admission from durable same-Worker recovery. */
export type WebUsbWorkerConnectionV03 = {
  mode: "initial" | "recovered";
  baselineRestoration: "not_required" | "confirmed";
};
/** Possession-bound browser adapter with explicit permission, reacquisition, and cleanup seams. */
export type WebUsbWorkerControllerV03 = WorkerControllerV03 &
  WorkerLeaseAuthorizationContextProvider & {
  /** The sole permission seam; callers invoke it synchronously from a direct user gesture. */
  requestPermission(): Promise<WebUsbWorkerConnectionV03>;
  /** Reacquires the same physical Worker after a disconnect or response-loss epoch. */
  reacquire(): Promise<WorkerControllerStatusV03>;
  /** Restores Mining Baseline before releasing and closing the local device. */
  close(reason?: WorkerRestorationReason): Promise<void>;
};
/** Deployment trust, permission, continuity, and timing inputs for one local Worker. */
export type WebUsbWorkerControllerV03Input = {
  deviceFilter: WorkerWebUsbDeviceFilter;
  trustedUpdateKeys: readonly unknown[];
  continuityScope: WorkerContinuityScope;
  transferTimeoutMilliseconds?: number;
};
/** Creates an unconnected, accountless Controller 0.3 adapter over browser WebUSB. */
export function createWebUsbWorkerControllerV03(
  input: WebUsbWorkerControllerV03Input,
): WebUsbWorkerControllerV03 {
  return new BrowserWebUsbWorkerControllerV03(input);
}
class BrowserWebUsbWorkerControllerV03 implements WebUsbWorkerControllerV03 {
  readonly #runtime: WorkerWebUsbRuntime;
  readonly #trustedUpdateKeys: readonly unknown[];
  readonly #continuity: WorkerContinuityAccess;
  readonly #authorizationContext = new WorkerWebUsbAuthorizationContext();
  readonly #challengeId: string;
  readonly #disconnectListeners = new Set<
    (reason: WorkerControllerDisconnectReason) => Promise<void>
  >();
  readonly #disconnectHandler: (event: WorkerWebUsbDisconnectEvent) => void;
  #maybeDevice: WorkerWebUsbDevice | undefined;
  #maybeCapabilities: WorkerControllerCapabilitiesV03 | undefined;
  #maybeDescriptor: unknown;
  #maybeDeviceIdentityFingerprint: string | undefined;
  #maybeEnumerationDevice: WorkerWebUsbDevice | undefined;
  #maybeRequiredRestorationReason: WorkerRestorationReason | undefined;
  #maybeUnconfirmedOutcomeMessage: string | undefined;
  #state: "unconnected" | "admitting" | "ready" | "restoration_pending" | "cleanup_pending" | "closed" =
    "unconnected";
  #sequence = 0;
  #possessionSequence = 0;
  #transportGeneration = 0;
  #operationActive = false;
  constructor(input: WebUsbWorkerControllerV03Input) {
    const maybeUsbTestOptions = (
      input as WebUsbWorkerControllerV03Input & {
        [workerWebUsbTestOptions]?: WorkerWebUsbTestOptions;
      }
    )[workerWebUsbTestOptions];
    this.#runtime = createWorkerWebUsbRuntime({
      deviceFilter: input.deviceFilter,
      ...(input.transferTimeoutMilliseconds === undefined
        ? {}
        : { transferTimeoutMilliseconds: input.transferTimeoutMilliseconds }),
      ...(maybeUsbTestOptions
        ? {
            usb: maybeUsbTestOptions.usb,
            userActivation: maybeUsbTestOptions.userActivation,
          }
        : {}),
    });
    this.#trustedUpdateKeys = structuredClone(input.trustedUpdateKeys);
    this.#challengeId = input.continuityScope.challengeId;
    const maybeTestOptions = (
      input as WebUsbWorkerControllerV03Input & {
        [workerContinuityTestOptions]?: WorkerContinuityTestOptions;
      }
    )[workerContinuityTestOptions];
    this.#continuity = createWorkerContinuityAccess(
      input.continuityScope,
      maybeTestOptions
        ? {
            store: maybeTestOptions.store,
            nowUnixSeconds: maybeTestOptions.nowUnixSeconds,
          }
        : {},
    );
    this.#disconnectHandler = (event) => {
      if (event.device !== this.#maybeDevice || this.#state === "closed") return;
      this.#transportGeneration += 1;
      this.#state = "restoration_pending";
      this.#maybeRequiredRestorationReason = "connectivity_lost";
      this.#maybeDevice = undefined;
      this.#authorizationContext.clear();
    };
    this.#runtime.usb.addEventListener("disconnect", this.#disconnectHandler);
  }

  async requestPermission() {
    if (this.#state !== "unconnected") {
      throw new Error("Worker WebUSB permission is already resolved");
    }
    assertWorkerWebUsbUserActivation(this.#runtime);
    const admitted = await this.#admitSelectedDevice(
      this.#continuity.maybeExpectedFingerprint(),
    );
    const maybeExpectedFingerprint = admitted.maybeExpectedFingerprint;
    try {
      this.#maybeDeviceIdentityFingerprint = admitted.deviceIdentityFingerprint;
      this.#authorizationContext.admit(admitted.possession);
      this.#maybeEnumerationDevice = admitted.device;
      this.#maybeCapabilities = admitted.capabilities;
      this.#maybeDescriptor = admitted.descriptor;
      if (maybeExpectedFingerprint) {
        const status = await this.#request(
          "status",
          undefined,
          true,
          parseWorkerControllerStatusV03,
        );
        if (status.state !== "baseline") {
          throw new Error("Worker WebUSB Mining Baseline restoration is unconfirmed");
        }
        this.#assertAdmissionCurrent(admitted);
        this.#state = "ready";
        return {
          mode: "recovered" as const,
          baselineRestoration: status.restoration.status,
        };
      }
      await this.#continuity.establish(admitted.deviceIdentityFingerprint);
      this.#assertAdmissionCurrent(admitted);
      this.#state = "ready";
      return {
        mode: "initial" as const,
        baselineRestoration: "not_required" as const,
      };
    } catch (error) {
      this.#authorizationContext.clear();
      this.#maybeDevice = undefined;
      await releaseAndCloseWorkerWebUsbDevice(admitted.device);
      const continuityLost =
        this.#transportGeneration !== admitted.transportGeneration;
      this.#state =
        maybeExpectedFingerprint || continuityLost
          ? "restoration_pending"
          : "unconnected";
      if (!maybeExpectedFingerprint && !continuityLost) {
        this.#maybeCapabilities = undefined;
        this.#maybeDescriptor = undefined;
        this.#maybeDeviceIdentityFingerprint = undefined;
        this.#maybeEnumerationDevice = undefined;
      }
      throw normalizeAdapterError(error);
    }
  }

  async reacquire() {
    if (
      this.#state !== "restoration_pending" ||
      !this.#maybeDeviceIdentityFingerprint
    ) {
      throw new Error("Worker WebUSB reacquisition is not required");
    }
    assertWorkerWebUsbUserActivation(this.#runtime);
    const admitted = await this.#admitSelectedDevice(
      this.#maybeDeviceIdentityFingerprint,
      this.#maybeEnumerationDevice,
    );
    this.#maybeDevice = admitted.device;
    this.#maybeCapabilities = admitted.capabilities;
    try {
      const status = await this.#request(
        "status",
        undefined,
        true,
        parseWorkerControllerStatusV03,
      );
      if (
        status.state !== "baseline" ||
        status.restoration.status !== "confirmed" ||
        !workerReacquisitionRestorationMatches(
          status.restoration.reason,
          this.#maybeRequiredRestorationReason,
        )
      ) {
        throw new Error("Worker WebUSB Mining Baseline restoration is unconfirmed");
      }
      try {
        await notifyWorkerDisconnect(this.#disconnectListeners);
      } catch {
        throw new Error("Worker WebUSB disconnect handling failed");
      }
      this.#assertAdmissionCurrent(admitted);
      this.#maybeRequiredRestorationReason = undefined;
      this.#maybeDeviceIdentityFingerprint = admitted.deviceIdentityFingerprint;
      this.#authorizationContext.admit(admitted.possession);
      this.#maybeEnumerationDevice = admitted.device;
      this.#maybeDescriptor = admitted.descriptor;
      this.#state = "ready";
      return status;
    } catch (error) {
      this.#state = "restoration_pending";
      this.#authorizationContext.clear();
      this.#maybeDevice = undefined;
      await releaseAndCloseWorkerWebUsbDevice(admitted.device);
      throw error;
    }
  }

  async discover() {
    this.#requireReady();
    const capabilities = this.#maybeCapabilities;
    if (!capabilities) throw new Error("Worker WebUSB capability admission is incomplete");
    return structuredClone(capabilities);
  }

  async prepareWorkerLeaseAuthorizationContext(
    operation: WorkerLeaseAuthorizationOperation,
  ): Promise<WorkerLeaseAuthorizationContext> {
    this.#requireReady();
    const expectedFingerprint = this.#maybeDeviceIdentityFingerprint;
    return this.#authorizationContext.prepare(operation, expectedFingerprint, async () => {
      const device = this.#maybeDevice;
      const descriptor = this.#maybeDescriptor;
      const capabilities = this.#maybeCapabilities;
      if (!device || !descriptor || !capabilities) {
        throw new Error("Worker WebUSB possession admission is incomplete");
      }
      return this.#provePossession(
        device,
        descriptor,
        capabilities,
        undefined,
      );
    });
  }

  async startLease(grant: WorkerLeaseGrantV03) {
    this.#authorizationContext.requireStart();
    const parsed = parseWorkerLeaseGrantV03(grant);
    if (parsed.challengeId !== this.#challengeId) {
      throw new Error("Work Lease does not match Worker continuity scope");
    }
    const status = await this.#statusRequest("start_lease", parsed);
    await this.#assertPostcondition(workerMiningStatusMatches(status, parsed), "control_failed",
      "Worker WebUSB Work Lease postcondition is invalid",
    );
    this.#authorizationContext.noteStarted();
    return status;
  }

  async renewLease(renewal: WorkerLeaseRenewalV03) {
    this.#authorizationContext.requireRenew();
    const parsed = parseWorkerLeaseRenewalV03(renewal);
    const status = await this.#statusRequest("renew_lease", parsed);
    await this.#assertPostcondition(
      workerMiningStatusMatches(status, { ...parsed, challengeId: this.#challengeId }), "control_failed",
      "Worker WebUSB Work Lease postcondition is invalid",
    );
    return status;
  }

  async status() {
    return this.#statusRequest("status");
  }

  async pause() {
    const status = await this.#statusRequest("pause");
    await this.#assertPostcondition(workerRestoredStatusMatches(status, "paused"), "paused",
      "Worker WebUSB Mining Baseline restoration is unconfirmed",
    );
    this.#authorizationContext.clear();
    return status;
  }

  async cancel() {
    const status = await this.#statusRequest("cancel");
    await this.#assertPostcondition(workerRestoredStatusMatches(status, "cancelled"), "cancelled",
      "Worker WebUSB Mining Baseline restoration is unconfirmed",
    );
    this.#authorizationContext.clear();
    await this.#continuity.clear();
    return status;
  }

  async restore(reason: WorkerRestorationReason) {
    const parsedReason = parseWorkerRestorationReason(reason);
    const status = await this.#statusRequest("restore", { reason: parsedReason });
    await this.#assertPostcondition(workerRestoredStatusMatches(status, parsedReason), parsedReason,
      "Worker WebUSB Mining Baseline restoration is unconfirmed",
    );
    this.#authorizationContext.clear();
    if (["cancelled", "challenge_satisfied", "challenge_expired"].includes(parsedReason)) {
      await this.#continuity.clear();
    }
    return status;
  }

  subscribeDisconnect(listener: (reason: WorkerControllerDisconnectReason) => Promise<void>) {
    this.#disconnectListeners.add(listener);
    return () => this.#disconnectListeners.delete(listener);
  }

  async close(reason: WorkerRestorationReason = "tab_closed") {
    if (this.#state === "closed") return;
    if (this.#state === "admitting") {
      throw new Error("Worker WebUSB operation is already active");
    }
    if (this.#state === "restoration_pending") {
      throw new Error("Worker WebUSB Mining Baseline restoration is unconfirmed");
    }
    const maybeDevice = this.#maybeDevice;
    if (this.#state === "cleanup_pending") {
      if (!maybeDevice) throw new Error("Worker WebUSB cleanup is incomplete");
      if (this.#maybeUnconfirmedOutcomeMessage) {
        await this.#retryUnconfirmedCleanup(maybeDevice);
      }
      await this.#finishClose(maybeDevice);
      return;
    }
    if (this.#state === "ready") {
      await this.restore(reason);
    }
    if (maybeDevice) {
      this.#state = "cleanup_pending";
      await this.#finishClose(maybeDevice);
      return;
    }
    this.#markClosed();
  }

  async #admitSelectedDevice(
    expectedFingerprint: string | undefined | Promise<string | undefined>,
    maybeForbiddenEnumerationDevice?: WorkerWebUsbDevice,
  ) {
    this.#state = "admitting";
    let maybeDevice: WorkerWebUsbDevice | undefined;
    try {
      const selected = await selectWorkerWebUsbDevice(this.#runtime);
      const { device, descriptor } = selected;
      const transportGeneration = this.#transportGeneration;
      maybeDevice = device;
      this.#maybeDevice = device;
      if (device === maybeForbiddenEnumerationDevice) {
        throw new Error("Worker WebUSB enumeration continuity is invalid");
      }
      const capability = await this.#request(
        "discover",
        undefined,
        true,
        parseWorkerControllerCapabilitiesV03,
      );
      const capabilities = await verifyWorkerControllerCapabilityV03(
        capability,
        descriptor,
        this.#trustedUpdateKeys,
      );
      const maybeExpectedFingerprint = await expectedFingerprint;
      const possession = await this.#provePossession(
        device,
        descriptor,
        capabilities,
        maybeExpectedFingerprint,
      );
      return {
        device,
        descriptor,
        capabilities,
        possession,
        deviceIdentityFingerprint: possession.deviceIdentityFingerprint,
        maybeExpectedFingerprint,
        transportGeneration,
      };
    } catch (error) {
      this.#maybeDevice = undefined;
      this.#authorizationContext.clear();
      if (maybeDevice) await releaseAndCloseWorkerWebUsbDevice(maybeDevice);
      this.#state = this.#maybeDeviceIdentityFingerprint
        ? "restoration_pending"
        : "unconnected";
      throw normalizeAdapterError(error);
    }
  }

  async #provePossession(
    device: WorkerWebUsbDevice,
    descriptor: unknown,
    capabilities: WorkerControllerCapabilitiesV03,
    maybeExpectedFingerprint: string | undefined,
  ): Promise<VerifiedWorkerPossession> {
    if (this.#operationActive) throw new Error("Worker WebUSB operation is already active");
    const generation = this.#transportGeneration;
    this.#operationActive = true;
    try {
      return await proveWorkerWebUsbPossession({
        device,
        descriptor,
        capabilities,
        ...(maybeExpectedFingerprint ? { maybeExpectedFingerprint } : {}),
        requestId: `pos_browser_${String(++this.#possessionSequence)}`,
        challengeBindingSha256: await this.#continuity.challengeBindingSha256(),
        runtime: this.#runtime,
        transportGeneration: generation,
        currentTransportGeneration: () => this.#transportGeneration,
      });
    } finally {
      this.#operationActive = false;
    }
  }

  async #statusRequest(
    command: "start_lease" | "renew_lease" | "status" | "pause" | "cancel" | "restore",
    maybePayload?: unknown,
  ) {
    return this.#request(command, maybePayload, false, parseWorkerControllerStatusV03);
  }

  async #request<Result = unknown>(
    command: WorkerControllerUsbRequestV03["command"],
    maybePayload?: unknown,
    admitting = false,
    parseResult: (input: unknown) => Result = (input) => input as Result,
  ): Promise<Result> {
    if (!admitting) this.#requireReady();
    if (this.#operationActive) throw new Error("Worker WebUSB operation is already active");
    const device = this.#maybeDevice;
    if (!device) throw new Error("Worker WebUSB device is unavailable");
    const transportGeneration = this.#transportGeneration;
    this.#operationActive = true;
    const request = {
      protocolVersion: WORKER_CONTROLLER_V03_PROTOCOL_VERSION,
      requestId: `usb_browser_${String(++this.#sequence)}`,
      command,
      ...(maybePayload === undefined ? {} : { payload: maybePayload }),
    } as WorkerControllerUsbRequestV03;
    const encoded = encodeWorkerControllerUsbMessageV03(request);
    let maybeTransferPhase: WorkerWebUsbTransferError["phase"] | undefined = undefined;
    try {
      const responseBytes = await transactWorkerWebUsb(
        device,
        encoded,
        MAXIMUM_WORKER_CONTROLLER_USB_FRAME_BYTES,
        this.#runtime.transferTimeoutMilliseconds,
      );
      const response = decodeWorkerControllerUsbResponseV03(responseBytes);
      assertWorkerControllerUsbCorrelationV03(request, response);
      if (transportGeneration !== this.#transportGeneration) {
        throw new Error("Worker WebUSB response transfer failed");
      }
      if (!response.ok) {
        throw new Error(
          response.error.code === "invalid_request"
            ? "Worker Controller USB request was invalid"
            : "Worker Controller command was rejected",
        );
      }
      return parseResult(response.result);
    } catch (error) {
      if (isDeviceCommandRejection(error)) throw error;
      if (error instanceof WorkerWebUsbTransferError) maybeTransferPhase = error.phase;
      this.#state = "restoration_pending";
      this.#maybeRequiredRestorationReason = "control_failed";
      this.#authorizationContext.clear();
      this.#maybeDevice = undefined;
      await releaseAndCloseWorkerWebUsbDevice(device);
      throw new Error(
        maybeTransferPhase !== "control_lost"
          ? "Worker WebUSB response was lost; reacquisition is required"
          : "Worker WebUSB control was lost; reacquisition is required",
      );
    } finally {
      this.#operationActive = false;
    }
  }

  #requireReady(): void {
    if (this.#state !== "ready") {
      throw new Error(
        this.#state === "restoration_pending"
          ? "Worker WebUSB reacquisition is required"
          : "Worker WebUSB permission is required",
      );
    }
  }

  #assertAdmissionCurrent(admitted: {
    device: WorkerWebUsbDevice;
    transportGeneration: number;
  }): void {
    if (
      this.#state !== "admitting" ||
      this.#maybeDevice !== admitted.device ||
      this.#transportGeneration !== admitted.transportGeneration
    ) {
      throw new Error("Worker WebUSB admission continuity was lost");
    }
  }

  async #assertPostcondition(
    matches: boolean,
    reason: WorkerRestorationReason,
    message: string,
  ): Promise<void> {
    if (matches) return;
    await this.#failClosedPostcondition(reason, message);
  }

  async #failClosedPostcondition(
    reason: WorkerRestorationReason,
    message: string,
  ): Promise<never> {
    const maybeDevice = this.#maybeDevice;
    this.#state = "restoration_pending";
    this.#maybeRequiredRestorationReason = reason;
    this.#authorizationContext.clear();
    this.#maybeUnconfirmedOutcomeMessage = message;
    const semanticError = new Error(message);
    if (!maybeDevice) throw semanticError;
    this.#state = "cleanup_pending";
    await closeWorkerAfterPostconditionFailure(maybeDevice, message);
    this.#maybeDevice = undefined;
    this.#state = "restoration_pending";
    throw semanticError;
  }

  async #retryUnconfirmedCleanup(device: WorkerWebUsbDevice): Promise<never> {
    const message = this.#maybeUnconfirmedOutcomeMessage ??
      "Worker WebUSB Mining Baseline restoration is unconfirmed";
    await closeWorkerAfterPostconditionFailure(device, message);
    this.#maybeDevice = undefined;
    this.#state = "restoration_pending";
    throw new Error(message);
  }

  async #finishClose(device: WorkerWebUsbDevice): Promise<void> {
    await releaseAndCloseWorkerWebUsbDeviceStrict(device);
    this.#markClosed();
  }

  #markClosed(): void {
    this.#state = "closed";
    this.#maybeDevice = undefined;
    this.#maybeCapabilities = undefined;
    this.#maybeDescriptor = undefined;
    this.#maybeDeviceIdentityFingerprint = undefined;
    this.#maybeEnumerationDevice = undefined;
    this.#maybeUnconfirmedOutcomeMessage = undefined;
    this.#authorizationContext.clear();
    this.#runtime.usb.removeEventListener("disconnect", this.#disconnectHandler);
  }
}
