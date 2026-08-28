import controllerFixtures from "../conformance/bwg-worker-controller-0.3/fixtures.json";
import transportFixtures from "../conformance/bwg-worker-usb-0.2/fixtures.json";
import possessionFixtures from "../conformance/bwg-worker-possession-0.1/fixtures.json";
import {
  createWebUsbWorkerControllerV03,
  type WebUsbWorkerControllerV03Input,
  type WorkerWebUsbAccess,
  type WorkerWebUsbDevice,
} from "./webusb-worker-controller-v03";
import { encodeWorkerControllerUsbMessageV03 } from "./worker-controller-usb-v03";
import { encodeWorkerPossessionMessage } from "./worker-possession-usb";
import {
  workerContinuityTestOptions,
  type WorkerContinuityStore,
} from "./worker-continuity-store";
import { workerWebUsbTestOptions } from "./webusb-worker-port";
import { encodeBase64Url } from "./crypto-bytes";
import { canonicalJson } from "./headless-values";

export function testController(
  input: Omit<WebUsbWorkerControllerV03Input, "continuityScope"> & {
    usb: WorkerWebUsbAccess;
    userActivation: () => boolean;
    continuityScope?: WebUsbWorkerControllerV03Input["continuityScope"];
    continuityStore?: WorkerContinuityStore;
    nowUnixSeconds?: () => number;
  },
) {
  const {
    continuityStore = memoryContinuityStore(),
    nowUnixSeconds = () => 1_000,
    continuityScope,
    usb,
    userActivation,
    ...controllerInput
  } = input;
  const internalInput = {
    ...controllerInput,
    continuityScope: continuityScope ?? {
      challengeId: "challenge_00000000000000000000000000000001",
      retentionExpiryUnixSeconds: 2_000,
    },
    [workerContinuityTestOptions]: { store: continuityStore, nowUnixSeconds },
    [workerWebUsbTestOptions]: { usb, userActivation },
  };
  return createWebUsbWorkerControllerV03(internalInput);
}

export function memoryContinuityStore(): WorkerContinuityStore {
  const records = new Map<string, unknown>();
  return {
    async get(key) {
      return structuredClone(records.get(key));
    },
    async compareAndEstablish(record) {
      const maybeExisting = records.get(record.challengeBindingSha256) as
        | typeof record
        | undefined;
      if (!maybeExisting) {
        records.set(record.challengeBindingSha256, structuredClone(record));
        return "established";
      }
      return maybeExisting.deviceIdentityFingerprint === record.deviceIdentityFingerprint &&
        maybeExisting.retentionExpiryUnixSeconds === record.retentionExpiryUnixSeconds
        ? "matched"
        : "conflict";
    },
    async delete(key) {
      records.delete(key);
    },
    async sweepExpired(nowUnixSeconds) {
      for (const [key, value] of records) {
        const record = value as { retentionExpiryUnixSeconds: number };
        if (record.retentionExpiryUnixSeconds <= nowUnixSeconds) records.delete(key);
      }
    },
  };
}

export function webUsbHarness(options: {
  controlSubclassCode?: number;
  maybeCapability?: unknown;
  maybePossessionResponse?: unknown;
  devices?: WorkerWebUsbDevice[];
} = {}) {
  let requests = 0;
  const disconnectListeners = new Set<(event: { device: WorkerWebUsbDevice }) => void>();
  const defaultDevice = makeDevice("fixture-worker-01", options);
  const devices = options.devices ?? [defaultDevice];
  const commands = () => devices.flatMap((device) => deviceCommands(device));
  const writes = () => commands().length;
  let deviceIndex = 0;
  const usb: WorkerWebUsbAccess = {
    async requestDevice() {
      requests += 1;
      const maybeDevice = devices[deviceIndex++];
      if (!maybeDevice) throw new Error("fixture device queue exhausted");
      return maybeDevice;
    },
    addEventListener(_type, listener) {
      disconnectListeners.add(listener);
    },
    removeEventListener(_type, listener) {
      disconnectListeners.delete(listener);
    },
  };
  return {
    usb,
    requestCount: () => requests,
    writeCount: writes,
    commands,
    disconnect(device: WorkerWebUsbDevice) {
      device.opened = false;
      for (const listener of disconnectListeners) listener({ device });
    },
  };
}

const commandLog = new WeakMap<WorkerWebUsbDevice, string[]>();

export function deviceCommands(device: WorkerWebUsbDevice): string[] {
  return commandLog.get(device) ?? [];
}

export function makeDevice(
  serialNumber?: string,
  options: {
    controlSubclassCode?: number;
    maybeCapability?: unknown;
    maybePossessionResponse?: unknown;
    maybeIdentity?: Promise<CryptoKeyPair>;
    maybeStatus?: unknown;
    events?: string[];
    maybeResponseLossCommand?: string;
    maybeRejectedCommand?: string;
    maybeInvalidStatusCommand?: string;
    maybeResultByCommand?: Record<string, unknown>;
    releaseFails?: boolean;
    closeFailsOnce?: boolean;
  } = {},
): WorkerWebUsbDevice {
  const topology = transportFixtures.topology.application.descriptor;
  const commands: string[] = [];
  const events = options.events ?? [];
  let remainingCloseFailures = options.closeFailsOnce ? 1 : 0;
  let maybeRequest: {
    command: string;
    requestId: string;
    payload?: { reason?: string; purpose?: string };
  } | undefined;
  const device: WorkerWebUsbDevice = {
    vendorId: 0x1209,
    productId: 0xb17a,
    ...(serialNumber === undefined ? {} : { serialNumber }),
    opened: false,
    configuration: null,
    configurations: [
      {
        configurationValue: topology.configurationValue,
        interfaces: [
          {
            interfaceNumber: topology.control.interfaceNumber,
            alternates: [
              {
                alternateSetting: topology.control.alternateSetting,
                interfaceClass: topology.control.classCode,
                interfaceSubclass:
                  options.controlSubclassCode ?? topology.control.subclassCode,
                interfaceProtocol: topology.control.protocolCode,
                endpoints: [
                  { endpointNumber: topology.control.endpointOut, direction: "out", type: "bulk" },
                  { endpointNumber: topology.control.endpointIn, direction: "in", type: "bulk" },
                ],
              },
            ],
          },
          {
            interfaceNumber: topology.evidence.communicationInterfaceNumber,
            alternates: [
              {
                alternateSetting: 0,
                interfaceClass: 2,
                interfaceSubclass: 2,
                interfaceProtocol: 1,
                endpoints: [
                  {
                    endpointNumber: topology.evidence.notificationEndpointIn,
                    direction: "in",
                    type: "interrupt",
                  },
                ],
              },
            ],
          },
          {
            interfaceNumber: topology.evidence.dataInterfaceNumber,
            alternates: [
              {
                alternateSetting: 0,
                interfaceClass: 10,
                interfaceSubclass: 0,
                interfaceProtocol: 0,
                endpoints: [
                  {
                    endpointNumber: topology.evidence.dataEndpointOut,
                    direction: "out",
                    type: "bulk",
                  },
                  {
                    endpointNumber: topology.evidence.dataEndpointIn,
                    direction: "in",
                    type: "bulk",
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
    async open() {
      this.opened = true;
      events.push("open");
    },
    async close() {
      events.push("close");
      if (remainingCloseFailures > 0) {
        remainingCloseFailures -= 1;
        throw new Error("secret device close failure");
      }
      this.opened = false;
    },
    async selectConfiguration() {
      this.configuration = this.configurations[0] ?? null;
    },
    async claimInterface(interfaceNumber) {
      events.push(`claim:${String(interfaceNumber)}`);
    },
    async selectAlternateInterface() {},
    async releaseInterface(interfaceNumber) {
      events.push(`release:${String(interfaceNumber)}`);
      if (options.releaseFails) throw new Error("secret device release failure");
    },
    async transferOut(_endpointNumber, data) {
      maybeRequest = JSON.parse(new TextDecoder().decode(data).trim()) as {
        command: string;
        requestId: string;
        payload?: { reason?: string; purpose?: string };
      };
      commands.push(maybeRequest.command);
      events.push(`write:${maybeRequest.command}`);
      return { status: "ok", bytesWritten: data.byteLength };
    },
    async transferIn() {
      if (!maybeRequest) throw new Error("fixture has no request");
      if (maybeRequest.command === options.maybeResponseLossCommand) {
        return new Promise<never>(() => undefined);
      }
      if (maybeRequest.command === "prove_possession") {
        const response = structuredClone(
          options.maybePossessionResponse ??
            await signedPossessionResponse(maybeRequest, options.maybeIdentity),
        ) as Record<string, unknown>;
        response.requestId = maybeRequest.requestId;
        events.push(`read:${maybeRequest.command}`);
        const bytes = encodeWorkerPossessionMessage(response);
        return {
          status: "ok",
          data: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        };
      }
      const vector = controllerFixtures.usbVectors.find(
        (candidate) => candidate.request?.command === maybeRequest?.command,
      );
      if (!vector) throw new Error("fixture response is missing");
      const response = structuredClone(vector.response) as Record<string, unknown>;
      response.requestId = maybeRequest.requestId;
      if (maybeRequest.command === options.maybeRejectedCommand) {
        response.ok = false;
        delete response.result;
        response.error = {
          code: "command_rejected",
          message: "secret-serial-must-not-escape password=fixture-session-password",
        };
      }
      if (maybeRequest.command === options.maybeInvalidStatusCommand) {
        response.result = { password: "must-not-escape" };
      }
      const maybeCommandResult = options.maybeResultByCommand?.[maybeRequest.command];
      if (maybeCommandResult !== undefined) response.result = maybeCommandResult;
      if (maybeRequest.command === "discover" && options.maybeCapability !== undefined) {
        response.result = options.maybeCapability;
      }
      if (maybeRequest.command === "status" && options.maybeStatus !== undefined) {
        response.result = options.maybeStatus;
      }
      if (maybeRequest.command === "restore") {
        response.result = {
          protocolVersion: "bwg-worker-controller/0.3",
          state: "baseline",
          monotonicMilliseconds: 10,
          restoration: { status: "confirmed", reason: maybeRequest.payload?.reason },
        };
      }
      events.push(`read:${maybeRequest.command}`);
      const bytes = encodeWorkerControllerUsbMessageV03(response);
      return {
        status: "ok",
        data: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      };
    },
  };
  commandLog.set(device, commands);
  return device;
}

async function signedPossessionResponse(request: {
  requestId: string;
  payload?: {
    purpose?: string;
    possessionNonce?: string;
    challengeBindingSha256?: string;
    controllerCapabilitySha256?: string;
    applicationDescriptorSha256?: string;
  };
}, maybeIdentity?: Promise<CryptoKeyPair>) {
  const payload = request.payload;
  if (
    !payload ||
    (payload.purpose !== "initial_admission" &&
      payload.purpose !== "transport_reacquisition") ||
    !payload.possessionNonce ||
    !payload.challengeBindingSha256 ||
    !payload.controllerCapabilitySha256 ||
    !payload.applicationDescriptorSha256
  ) {
    throw new Error("fixture possession request is invalid");
  }
  const maybePair = maybeIdentity ? await maybeIdentity : undefined;
  const publicJwk = maybePair
    ? await crypto.subtle.exportKey("jwk", maybePair.publicKey)
    : possessionFixtures.fixtureIdentity.publicJwk;
  const claims = {
    profile: "bwg-worker-possession-proof/0.1",
    purpose: payload.purpose,
    possessionNonce: payload.possessionNonce,
    challengeBindingSha256: payload.challengeBindingSha256,
    controllerCapabilitySha256: payload.controllerCapabilitySha256,
    applicationDescriptorSha256: payload.applicationDescriptorSha256,
    deviceIdentityJwk: {
      kty: "OKP",
      crv: "Ed25519",
      x: publicJwk.x,
      alg: "Ed25519",
      use: "sig",
      key_ops: ["verify"],
    },
  };
  const protectedHeader = encodeBase64Url(
    new TextEncoder().encode(canonicalJson({
      alg: "Ed25519",
      typ: "bwg-worker-possession+jws",
    })),
  );
  const encodedClaims = encodeBase64Url(
    new TextEncoder().encode(canonicalJson(claims)),
  );
  const privateKey = maybePair?.privateKey ?? await crypto.subtle.importKey(
      "jwk",
      {
        ...possessionFixtures.fixtureIdentity.publicJwk,
        d: "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A",
        key_ops: ["sign"],
        ext: false,
      },
      "Ed25519",
      false,
      ["sign"],
    );
  const signature = await crypto.subtle.sign(
    "Ed25519",
    privateKey,
    new TextEncoder().encode(`${protectedHeader}.${encodedClaims}`),
  );
  return {
    profile: "bwg-worker-possession/0.1",
    requestId: request.requestId,
    ok: true,
    result: {
      claims,
      compactJws: `${protectedHeader}.${encodedClaims}.${encodeBase64Url(new Uint8Array(signature))}`,
    },
  };
}

export function restoredDevice(serialNumber: string): WorkerWebUsbDevice {
  return makeDevice(serialNumber, {
    maybeStatus: {
      protocolVersion: "bwg-worker-controller/0.3",
      state: "baseline",
      monotonicMilliseconds: 10,
      restoration: { status: "confirmed", reason: "connectivity_lost" },
    },
  });
}

export async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("test condition was not reached");
}
