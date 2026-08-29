import { encodeBase64Url, sha256Base64UrlBytes } from "./crypto-bytes";
import { canonicalJson } from "./headless-values";
import type {
  WorkerLeaseAuthorizationContext,
  WorkerLeaseAuthorizationOperation,
} from "./worker-lease-authorization";
import {
  createWorkerPossessionChallenge,
  type VerifiedWorkerPossession,
} from "./worker-possession";
import {
  MAXIMUM_WORKER_POSSESSION_FRAME_BYTES,
  decodeWorkerPossessionResponse,
  encodeWorkerPossessionMessage,
} from "./worker-possession-usb";
import type { WorkerControllerCapabilitiesV03 } from "./worker-controller-v03";
import {
  transactWorkerWebUsb,
  type WorkerWebUsbDevice,
  type WorkerWebUsbRuntime,
} from "./webusb-worker-port";

/** Holds only the live possession binding required by browser-side lease authorization. */
export class WorkerWebUsbAuthorizationContext {
  #maybeBinding: string | undefined;
  #active = false;

  admit(possession: VerifiedWorkerPossession): void {
    this.#maybeBinding = possession.controlSessionBindingSha256;
    this.#active = false;
  }

  clear(): void {
    this.#maybeBinding = undefined;
    this.#active = false;
  }

  requireStart(): void {
    if (!this.#maybeBinding || this.#active) {
      throw new Error("Worker WebUSB Start authorization context is unavailable");
    }
  }

  requireRenew(): void {
    if (!this.#maybeBinding || !this.#active) {
      throw new Error("Worker WebUSB active authorization context is unavailable");
    }
  }

  noteStarted(): void {
    this.requireStart();
    this.#active = true;
  }

  async prepare(
    operation: WorkerLeaseAuthorizationOperation,
    expectedFingerprint: string | undefined,
    proveFresh: () => Promise<VerifiedWorkerPossession>,
  ): Promise<WorkerLeaseAuthorizationContext> {
    if (operation === "renew") {
      this.requireRenew();
      return { controlSessionBindingSha256: this.#requiredBinding() };
    }
    if (operation !== "start" || this.#active) {
      throw new Error("Worker WebUSB Start authorization context is unavailable");
    }
    if (!expectedFingerprint) {
      throw new Error("Worker WebUSB possession admission is incomplete");
    }
    const possession = await proveFresh();
    if (possession.deviceIdentityFingerprint !== expectedFingerprint) {
      this.clear();
      throw new Error("Worker WebUSB Device Identity continuity is invalid");
    }
    this.admit(possession);
    return { controlSessionBindingSha256: this.#requiredBinding() };
  }

  #requiredBinding(): string {
    const binding = this.#maybeBinding;
    if (!binding) throw new Error("Worker WebUSB authorization context is unavailable");
    return binding;
  }
}

/** Runs one fresh possession exchange against the currently enumerated USB transport. */
export async function proveWorkerWebUsbPossession(input: {
  device: WorkerWebUsbDevice;
  descriptor: unknown;
  capabilities: WorkerControllerCapabilitiesV03;
  maybeExpectedFingerprint?: string;
  requestId: string;
  challengeBindingSha256: string;
  expectedFirmwareSourceCommit?: string;
  runtime: WorkerWebUsbRuntime;
  transportGeneration: number;
  currentTransportGeneration: () => number;
}): Promise<VerifiedWorkerPossession> {
  const controllerCapabilitySha256 = await sha256Base64UrlBytes(
    new TextEncoder().encode(canonicalJson(input.capabilities)),
  );
  const applicationDescriptorSha256 = await sha256Base64UrlBytes(
    new TextEncoder().encode(canonicalJson(input.descriptor)),
  );
  const common = {
    requestId: input.requestId,
    possessionNonce: encodeBase64Url(crypto.getRandomValues(new Uint8Array(32))),
    challengeBindingSha256: input.challengeBindingSha256,
    controllerCapabilitySha256,
    applicationDescriptorSha256,
    ...(input.expectedFirmwareSourceCommit
      ? { expectedFirmwareSourceCommit: input.expectedFirmwareSourceCommit }
      : {}),
  };
  const challenge = input.maybeExpectedFingerprint
    ? createWorkerPossessionChallenge({
        ...common,
        purpose: "transport_reacquisition",
        expectedDeviceIdentityFingerprint: input.maybeExpectedFingerprint,
      })
    : createWorkerPossessionChallenge({
        ...common,
        purpose: "initial_admission",
      });
  const responseBytes = await transactWorkerWebUsb(
    input.device,
    encodeWorkerPossessionMessage(challenge.request),
    MAXIMUM_WORKER_POSSESSION_FRAME_BYTES,
    input.runtime.transferTimeoutMilliseconds,
  );
  if (input.transportGeneration !== input.currentTransportGeneration()) {
    throw new Error("Worker WebUSB possession response was lost");
  }
  return challenge.verify(decodeWorkerPossessionResponse(responseBytes));
}
