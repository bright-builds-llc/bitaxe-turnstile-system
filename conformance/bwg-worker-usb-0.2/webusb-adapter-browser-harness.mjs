import {
  createWebUsbWorkerControllerV03,
  workerWebUsbTestOptions,
} from "/dist/test-worker-controller-v03/worker-controller-v03-browser-test-entry.js";
import {
  encodeWorkerControllerUsbMessageV03,
} from "/dist/worker-controller-v03/worker-controller-v03-entry.js";
import {
  encodeWorkerPossessionMessage,
} from "/dist/worker-possession/worker-possession-entry.js";

const [controllerFixtures, transportFixtures, deploymentFixtures] = await Promise.all([
  fetch("./../bwg-worker-controller-0.3/fixtures.json").then(requiredJson),
  fetch("./fixtures.json").then(requiredJson),
  fetch("./../bwg-worker-deployment-trust-0.1/fixtures.json").then(requiredJson),
]);
const output = requiredElement("result");
const details = requiredElement("details");
const completed = new Set();
const redactedFacts = [];
const prohibitedVisibleBytes = new Set();
const fixtureIdentity = crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"]);

const outsideGestureHarness = webUsbHarness([makeDevice("browser-worker-01")]);
const outsideGestureController = controller(outsideGestureHarness.usb);
await expectFailure(
  outsideGestureController.requestPermission(),
  "direct user gesture",
  "permission_without_gesture",
);
assertEqual(outsideGestureHarness.requestCount(), 0, "permission_without_gesture_request_count");

requiredElement("connect").addEventListener("click", () => {
  void run("happy", async () => {
    const events = [];
    const harness = webUsbHarness([makeDevice("browser-worker-01", { events })]);
    const challengeId = `challenge_browser_${crypto.randomUUID()}`;
    const adapter = controller(harness.usb, challengeId);
    const connection = await adapter.requestPermission();
    const capabilities = await adapter.discover();
    await adapter.startLease({ ...controllerFixtures.lease, challengeId });
    await adapter.close("challenge_satisfied");
    assertEqual(capabilities.transportProfile, "bwg-worker-usb/0.2", "signed_capability");
    assertEqual(
      harness.commands().join(","),
      "discover,prove_possession,start_lease,restore",
      "happy_commands",
    );
    assertEqual(
      events.slice(-4).join(","),
      "write:restore,read:restore,release:0,close",
      "restoration_before_close",
    );
    redactedFacts.push({ scenario: "happy", status: "baseline_restored" });
  });
});

requiredElement("reject").addEventListener("click", () => {
  void run("wrong_function", async () => {
    const harness = webUsbHarness([
      makeDevice("browser-worker-01", { controlSubclassCode: 2 }),
    ]);
    const adapter = controller(harness.usb);
    await expectFailure(
      adapter.requestPermission(),
      "application descriptor is invalid",
      "wrong_function",
    );
    assertEqual(harness.commands().length, 0, "wrong_function_write_count");
    redactedFacts.push({ scenario: "wrong_function", status: "rejected_before_write" });
  });
});

requiredElement("wrong-device").addEventListener("click", () => {
  void run("wrong_device", async () => {
    const harness = webUsbHarness([
      makeDevice("browser-worker-01", { vendorId: 0x9999 }),
    ]);
    const adapter = controller(harness.usb);
    await expectFailure(
      adapter.requestPermission(),
      "selected device is invalid",
      "wrong_device",
    );
    assertEqual(harness.commands().length, 0, "wrong_device_write_count");
    redactedFacts.push({ scenario: "wrong_device", status: "rejected_before_write" });
  });
});

requiredElement("reacquire").addEventListener("click", () => {
  void run("reacquisition", async () => {
    const first = makeDevice("browser-worker-01");
    const restored = makeDevice("browser-worker-01", {
      maybeStatus: {
        protocolVersion: "bwg-worker-controller/0.3",
        state: "baseline",
        monotonicMilliseconds: 9,
        restoration: { status: "confirmed", reason: "connectivity_lost" },
      },
    });
    const harness = webUsbHarness([first, first, restored]);
    const adapter = controller(harness.usb);
    const disconnects = [];
    adapter.subscribeDisconnect(async (reason) => disconnects.push(reason));
    await adapter.requestPermission();
    harness.disconnect(first);
    await expectFailure(adapter.status(), "reacquisition is required", "stale_device_state");
    const commandsBeforeStaleReacquisition = harness.commands().length;
    await expectFailure(
      adapter.reacquire(),
      "enumeration continuity is invalid",
      "stale_enumeration",
    );
    assertEqual(
      harness.commands().length,
      commandsBeforeStaleReacquisition,
      "stale_enumeration_write_count",
    );
    const status = await adapter.reacquire();
    assertEqual(status.restoration.reason, "connectivity_lost", "restoration_proof");
    assertEqual(disconnects.join(","), "connectivity_lost", "disconnect_notification");
    redactedFacts.push({ scenario: "reacquisition", status: "same_worker_restored" });
  });
});

requiredElement("durable").addEventListener("click", () => {
  void run("durable_recovery", async () => {
    const challengeId = `challenge_browser_${crypto.randomUUID()}`;
    const first = makeDevice("browser-worker-01");
    const restored = makeDevice("browser-worker-01", {
      maybeStatus: {
        protocolVersion: "bwg-worker-controller/0.3",
        state: "baseline",
        monotonicMilliseconds: 9,
        restoration: { status: "confirmed", reason: "connectivity_lost" },
      },
    });
    const harness = webUsbHarness([first, restored]);
    const initial = controller(harness.usb, challengeId);
    await initial.requestPermission();
    harness.disconnect(first);
    const recovered = controller(harness.usb, challengeId);
    const connection = await recovered.requestPermission();
    assertEqual(connection.mode, "recovered", "durable_recovery_mode");
    assertEqual(connection.baselineRestoration, "confirmed", "durable_recovery_baseline");
    redactedFacts.push({ scenario: "durable_recovery", status: "same_worker_restored" });
  });
});

requiredElement("atomic").addEventListener("click", () => {
  void run("atomic_admission", async () => {
    const challengeId = `challenge_browser_${crypto.randomUUID()}`;
    const firstHarness = webUsbHarness([makeDevice("browser-worker-01")]);
    const secondHarness = webUsbHarness([
      makeDevice("browser-worker-02", {
        maybeIdentity: crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"]),
      }),
    ]);
    const first = controller(firstHarness.usb, challengeId);
    const second = controller(secondHarness.usb, challengeId);
    const results = await Promise.allSettled([
      first.requestPermission(),
      second.requestPermission(),
    ]);
    assertEqual(
      results.map((result) => result.status).sort().join(","),
      "fulfilled,rejected",
      "atomic_first_worker",
    );
    redactedFacts.push({ scenario: "atomic_admission", status: "one_worker_established" });
  });
});

document.body.dataset.harness = "ready";

function controller(usb, challengeId = `challenge_browser_${crypto.randomUUID()}`) {
  return createWebUsbWorkerControllerV03({
    deviceFilter: { vendorId: 0x1209, productId: 0xb17a },
    trustedUpdateKeys: deploymentFixtures.trust.updateAuthority.keys,
    continuityScope: {
      challengeId,
      retentionExpiryUnixSeconds: Math.floor(Date.now() / 1000) + 300,
    },
    [workerWebUsbTestOptions]: {
      usb,
      userActivation: () => navigator.userActivation.isActive,
    },
  });
}

function webUsbHarness(devices) {
  let deviceIndex = 0;
  let requestCount = 0;
  const disconnectListeners = new Set();
  return {
    usb: {
      async requestDevice(options) {
        assertEqual(navigator.userActivation.isActive, true, "active_user_gesture");
        assertEqual(options.filters.length, 1, "one_device_filter");
        requestCount += 1;
        const device = devices[deviceIndex++];
        if (!device) throw new Error("fixture device queue exhausted");
        return device;
      },
      addEventListener(_type, listener) {
        disconnectListeners.add(listener);
      },
      removeEventListener(_type, listener) {
        disconnectListeners.delete(listener);
      },
    },
    requestCount: () => requestCount,
    commands: () => devices.flatMap((device) => device.commands),
    disconnect(device) {
      device.opened = false;
      for (const listener of disconnectListeners) listener({ device });
    },
  };
}

function makeDevice(serialNumber, options = {}) {
  const descriptor = structuredClone(transportFixtures.topology.application.descriptor);
  descriptor.control.subclassCode = options.controlSubclassCode ?? descriptor.control.subclassCode;
  let maybeRequest;
  let maybeActiveChallengeId;
  const events = options.events ?? [];
  return {
    vendorId: options.vendorId ?? 0x1209,
    productId: 0xb17a,
    serialNumber,
    opened: false,
    configuration: null,
    configurations: configurationsFor(descriptor),
    commands: [],
    async open() {
      this.opened = true;
      events.push("open");
    },
    async close() {
      this.opened = false;
      events.push("close");
    },
    async selectConfiguration() {
      this.configuration = this.configurations[0];
    },
    async claimInterface(number) {
      events.push(`claim:${number}`);
    },
    async selectAlternateInterface() {},
    async releaseInterface(number) {
      events.push(`release:${number}`);
    },
    async transferOut(_endpoint, bytes) {
      maybeRequest = JSON.parse(new TextDecoder().decode(bytes).trim());
      collectPrivateValues(maybeRequest);
      this.commands.push(maybeRequest.command);
      events.push(`write:${maybeRequest.command}`);
      return { status: "ok", bytesWritten: bytes.byteLength };
    },
    async transferIn() {
      if (maybeRequest.command === "prove_possession") {
        const response = await possessionResponse(maybeRequest, options.maybeIdentity ?? fixtureIdentity);
        events.push(`read:${maybeRequest.command}`);
        const bytes = encodeWorkerPossessionMessage(response);
        return { status: "ok", data: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
      }
      const vector = controllerFixtures.usbVectors.find(
        (candidate) => candidate.request?.command === maybeRequest?.command,
      );
      if (!vector) throw new Error("fixture response is missing");
      const response = structuredClone(vector.response);
      response.requestId = maybeRequest.requestId;
      if (maybeRequest.command === "discover") {
        response.result = deploymentFixtures.ultra205.signedCapability;
      }
      if (maybeRequest.command === "start_lease") {
        maybeActiveChallengeId = maybeRequest.payload.challengeId;
        response.result = miningStatusFor(maybeRequest.payload, maybeActiveChallengeId, 0);
      }
      if (maybeRequest.command === "renew_lease") {
        response.result = miningStatusFor(maybeRequest.payload, maybeActiveChallengeId, 10_000);
      }
      if (maybeRequest.command === "status" && options.maybeStatus) {
        response.result = options.maybeStatus;
      }
      if (maybeRequest.command === "restore") {
        response.result = {
          protocolVersion: "bwg-worker-controller/0.3",
          state: "baseline",
          monotonicMilliseconds: 10,
          restoration: { status: "confirmed", reason: maybeRequest.payload.reason },
        };
      }
      events.push(`read:${maybeRequest.command}`);
      const bytes = encodeWorkerControllerUsbMessageV03(response);
      return { status: "ok", data: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
    },
  };
}

function miningStatusFor(lease, challengeId, monotonicMilliseconds) {
  if (!challengeId) throw new Error("active challenge is missing");
  return {
    protocolVersion: "bwg-worker-controller/0.3",
    state: "mining",
    monotonicMilliseconds,
    lease: {
      leaseId: lease.leaseId,
      challengeId,
      renewAtMonotonicMilliseconds: monotonicMilliseconds + lease.renewAfterMilliseconds,
      expiresAtMonotonicMilliseconds: monotonicMilliseconds + lease.durationMilliseconds,
    },
    restoration: { status: "pending" },
  };
}

async function possessionResponse(request, identityPromise) {
  const identity = await identityPromise;
  const publicJwk = await crypto.subtle.exportKey("jwk", identity.publicKey);
  const claims = {
    profile: "bwg-worker-possession-proof/0.1",
    ...request.payload,
    deviceIdentityJwk: {
      kty: "OKP",
      crv: "Ed25519",
      x: publicJwk.x,
      alg: "Ed25519",
      use: "sig",
      key_ops: ["verify"],
    },
  };
  const protectedHeader = base64Url(canonicalJson({
    alg: "Ed25519",
    typ: "bwg-worker-possession+jws",
  }));
  const payload = base64Url(canonicalJson(claims));
  const signature = await crypto.subtle.sign(
    "Ed25519",
    identity.privateKey,
    new TextEncoder().encode(`${protectedHeader}.${payload}`),
  );
  const compactJws = `${protectedHeader}.${payload}.${bytesBase64Url(new Uint8Array(signature))}`;
  prohibitedVisibleBytes.add(claims.deviceIdentityJwk.x);
  prohibitedVisibleBytes.add(compactJws);
  prohibitedVisibleBytes.add(await sha256Base64Url(canonicalJson(claims.deviceIdentityJwk)));
  return {
    profile: "bwg-worker-possession/0.1",
    requestId: request.requestId,
    ok: true,
    result: {
      claims,
      compactJws,
    },
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function base64Url(value) {
  return bytesBase64Url(new TextEncoder().encode(value));
}

function bytesBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function sha256Base64Url(value) {
  return bytesBase64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
  );
}

function collectPrivateValues(value) {
  if (typeof value === "string") {
    if (value.length >= 8) prohibitedVisibleBytes.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPrivateValues(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (
      [
        "authorization",
        "username",
        "password",
        "challengeId",
        "possessionNonce",
        "challengeBindingSha256",
      ].includes(key)
    ) {
      collectPrivateValues(item);
    }
  }
}

function configurationsFor(descriptor) {
  return [{
    configurationValue: descriptor.configurationValue,
    interfaces: [
      usbInterface(descriptor.control.interfaceNumber, descriptor.control.alternateSetting,
        descriptor.control.classCode, descriptor.control.subclassCode,
        descriptor.control.protocolCode, [endpoint(1, "out", "bulk"), endpoint(1, "in", "bulk")]),
      usbInterface(descriptor.evidence.communicationInterfaceNumber, 0, 2, 2, 1,
        [endpoint(2, "in", "interrupt")]),
      usbInterface(descriptor.evidence.dataInterfaceNumber, 0, 10, 0, 0,
        [endpoint(3, "out", "bulk"), endpoint(3, "in", "bulk")]),
    ],
  }];
}

function usbInterface(interfaceNumber, alternateSetting, interfaceClass, interfaceSubclass,
  interfaceProtocol, endpoints) {
  return { interfaceNumber, alternates: [{ alternateSetting, interfaceClass, interfaceSubclass,
    interfaceProtocol, endpoints }] };
}

function endpoint(endpointNumber, direction, type) {
  return { endpointNumber, direction, type };
}

async function run(id, operation) {
  try {
    await operation();
    completed.add(id);
    if (completed.size === 6) {
      const serialized = JSON.stringify(redactedFacts);
      if (/password|authorization|serial|browser-worker/i.test(serialized)) {
        throw new Error("browser-visible details contain prohibited data");
      }
      const visible = `${document.body.innerHTML}\n${document.body.textContent ?? ""}`;
      for (const privateValue of prohibitedVisibleBytes) {
        if (visible.includes(privateValue)) {
          throw new Error("actual private protocol bytes reached browser-visible state");
        }
      }
      details.textContent = serialized;
      output.textContent = "passed";
      output.dataset.status = "passed";
    }
  } catch (error) {
    details.textContent = error instanceof Error ? error.message : String(error);
    output.textContent = "failed";
    output.dataset.status = "failed";
  }
}

async function expectFailure(operation, message, label) {
  try {
    await operation;
  } catch (error) {
    if (error instanceof Error && error.message.includes(message)) return;
    throw new Error(`${label}: unexpected failure`);
  }
  throw new Error(`${label}: expected failure`);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, received ${actual}`);
}

function requiredElement(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing browser fixture element: ${id}`);
  return element;
}

async function requiredJson(response) {
  if (!response.ok) throw new Error(`fixture request failed: ${response.status}`);
  return response.json();
}
