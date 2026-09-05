import {
  createWebSerialWorkerController,
  workerSerialQualificationHook,
  type WebSerialWorkerController,
  type WebSerialWorkerControllerInput,
  type WorkerSerialQualificationHook,
} from "./webserial-worker-controller";
import {
  parseWorkerLeaseGrant,
  parseWorkerLeaseRenewal,
  type WorkerLeaseGrant,
  type WorkerLeaseRenewal,
  type WorkerQualification,
} from "./worker-controller";
import {
  parseWorkerDeploymentTrust,
  type WorkerDeploymentTrust,
} from "./worker-deployment-trust";

declare const BWG_GATE_SOURCE_COMMIT: string;
const gateCommit =
  typeof BWG_GATE_SOURCE_COMMIT === "string"
    ? BWG_GATE_SOURCE_COMMIT
    : "Unavailable";
type Configuration = {
  expectedGateCommit: string;
  expectedFirmwareSourceCommit: string;
  expectedAppElfSha256: string;
  trust: WorkerDeploymentTrust;
};
type WindowArtifacts = {
  grant: WorkerLeaseGrant;
  renewals: WorkerLeaseRenewal[];
};
const hook: WorkerSerialQualificationHook = {
  suppressHeartbeats: false,
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
let maybeController: WebSerialWorkerController | undefined;
let maybeWindow: WindowArtifacts | undefined;
let maybeTimer: ReturnType<typeof setInterval> | undefined;
let polling = false;
let status = "unconfigured";
let maybeFailure: string | undefined;
let maybeQualification: WorkerQualification | undefined;
let maybeProbe: unknown;
let connected = false,
  running = false;
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
    ...(maybeConfiguration
      ? {
          expectedFirmwareSourceCommit:
            maybeConfiguration.expectedFirmwareSourceCommit,
          expectedAppElfSha256: maybeConfiguration.expectedAppElfSha256,
        }
      : {}),
    ...(maybeQualification ? { qualification: maybeQualification } : {}),
    ...(maybeProbe ? { probe: maybeProbe } : {}),
    ...(maybeFailure ? { failure: maybeFailure } : {}),
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
  if (connected || running) throw new Error("configuration_while_connected");
  if (
    !/^[0-9a-f]{40}$/u.test(input.expectedGateCommit) ||
    input.expectedGateCommit !== gateCommit
  )
    throw new Error("gate_source_mismatch");
  if (
    !/^[0-9a-f]{40}$/u.test(input.expectedFirmwareSourceCommit) ||
    !/^[0-9a-f]{64}$/u.test(input.expectedAppElfSha256) ||
    Object.keys(input).length !== 4 ||
    Object.keys(input).some(
      (key) =>
        ![
          "expectedGateCommit",
          "expectedFirmwareSourceCommit",
          "expectedAppElfSha256",
          "trust",
        ].includes(key),
    )
  )
    throw new Error("configuration_invalid");
  maybeConfiguration = {
    ...input,
    trust: parseWorkerDeploymentTrust(input.trust),
  };
  status = "configured";
  maybeFailure = undefined;
  publish();
}
async function connect() {
  const config = maybeConfiguration;
  if (!config) throw new Error("configuration_missing");
  if (connected) throw new Error("already_connected");
  hook.suppressHeartbeats = false;
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
async function prepareStartAuthorization() {
  const context =
    await controller().prepareWorkerLeaseAuthorizationContext("start");
  const output = document.querySelector<HTMLTextAreaElement>(
    "#authorization-context",
  );
  if (output) output.value = context.controlSessionBindingSha256;
  await localJson("/authorization-context", context);
  return context;
}
function loadWindow(input: WindowArtifacts) {
  if (running) throw new Error("window_active");
  const grant = parseWorkerLeaseGrant(input.grant);
  if (!grant.acceptanceCampaign)
    throw new Error("acceptance_campaign_required");
  if (!Array.isArray(input.renewals) || input.renewals.length > 16)
    throw new Error("renewal_bound");
  const renewals = input.renewals.map(parseWorkerLeaseRenewal);
  if (renewals.some((value) => value.leaseId !== grant.leaseId))
    throw new Error("renewal_lease_mismatch");
  maybeWindow = { grant, renewals };
  status = "window_loaded";
  publish();
}
async function loadSignedWindow() {
  loadWindow(await localJson("/window-artifacts"));
  return state();
}
async function localJson(path: string, body?: object): Promise<any> {
  try {
    const response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      cache: "no-store",
      credentials: "omit",
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
    if (!response.ok || !response.body) throw new Error("local_response");
    const reader = response.body.getReader();
    const bytes = new Uint8Array(65_536);
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (length + value.length > bytes.length)
          throw new Error("local_bound");
        bytes.set(value, length);
        length += value.length;
      }
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(0, length),
        ),
      );
    } finally {
      bytes.fill(0);
      reader.releaseLock();
    }
  } catch {
    throw new Error("local_input_invalid");
  }
}
async function refresh() {
  const observed = await controller().status();
  maybeQualification = observed.qualification;
  publish();
  return state();
}
async function tick() {
  if (polling || !running || !maybeWindow) return;
  polling = true;
  try {
    const now = performance.now();
    const duration =
      maybeWindow.grant.acceptanceCampaign?.maximumActiveMilliseconds;
    if (duration === undefined) throw new Error("campaign_missing");
    if (now - began >= duration) {
      await stop();
      return;
    }
    if (now >= nextRenew) {
      const renewal = maybeWindow.renewals.shift();
      if (!renewal) throw new Error("renewal_exhausted");
      await controller().renewLease(renewal);
      nextRenew = performance.now() + renewal.renewAfterMilliseconds;
    }
    await refresh();
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
  const observed = await controller().startLease(input.grant);
  maybeQualification = observed.qualification;
  running = true;
  status = "running";
  began = performance.now();
  nextRenew = began + input.grant.renewAfterMilliseconds;
  maybeTimer = setInterval(() => {
    void tick();
  }, 1000);
  publish();
  return state();
}
async function stop() {
  stopTimer();
  running = false;
  status = "stopping";
  publish();
  const observed = await controller().pause();
  maybeQualification = observed.qualification;
  running = false;
  maybeWindow = undefined;
  status = "baseline_confirmed";
  publish();
  return state();
}
async function close() {
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
function suppressHeartbeats() {
  if (!running || !maybeWindow?.grant.acceptanceCampaign)
    throw new Error("qualification_window_required");
  hook.suppressHeartbeats = true;
  publish();
}
export const workerAcceptance = {
  configure,
  connect,
  prepareStartAuthorization,
  loadWindow,
  loadSignedWindow,
  startWindow,
  stop,
  close,
  refresh,
  probe,
  suppressHeartbeats,
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
] as const) {
  document.getElementById(id)?.addEventListener("click", () => {
    Promise.resolve()
      .then(action)
      .catch(() => fail(`${id}_failed`));
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
