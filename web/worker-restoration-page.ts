import { acceptanceLocalJson as localJson } from "./worker-acceptance-local";
import { parseWorkerAcceptanceActivation } from "./worker-acceptance-activation";
import { bindWorkerQualificationConnect } from "./worker-qualification-gesture";
import { flushRecoverySupervisor } from "./worker-recovery-loss";
import { createWorkerRestorationOperations } from "./worker-restoration-operations";
import { WorkerRestorationHighWater } from "./worker-restoration-qualification";
import { requireWorkerAcceptanceModeTransition, parseWorkerSerialAcceptanceConfiguration, type WorkerSerialAcceptanceConfiguration } from "./worker-serial-acceptance-config";
import {
  createWebSerialWorkerController, workerSerialQualificationHook, type WebSerialWorkerControllerInput, type WorkerSerialQualificationHook,
} from "./webserial-worker-controller";

declare const BWG_GATE_SOURCE_COMMIT: string;
const gateCommit = typeof BWG_GATE_SOURCE_COMMIT === "string" ? BWG_GATE_SOURCE_COMMIT : "Unavailable";
const highWater = new WorkerRestorationHighWater();
let maybeConfiguration: WorkerSerialAcceptanceConfiguration | undefined;
let maybeConfigurationFailure: "configuration_failed" | undefined;

function publish() {
  const output = document.querySelector("#state");
  if (output) output.textContent = JSON.stringify(operations.state(), null, 2);
}
const hook: WorkerSerialQualificationHook = {
  suppressHeartbeats: false,
  memoryOnlyContinuity: true,
  allowClockDiscontinuityStimulus: false,
  observeStatus: value => { operations.observeStatus(value); publish(); },
  observePreservation: value => { highWater.observe(value); },
  maybeObserveAdmissionFailure: stage => { operations.observeAdmissionFailure(stage); },
  maybeObserveSerialFailure: category => { operations.observeSerialFailure(category); },
  maybeObserveDiagnostic: value => { operations.observeDiagnostic(value); },
  async prepareScope() { return parseWorkerAcceptanceActivation(await localJson("/activate", {})); },
};
const operations = createWorkerRestorationOperations({
  enabled: () => maybeConfiguration?.restorationQualification === true,
  createController() {
    const config = maybeConfiguration;
    if (!config) throw new Error("configuration_missing");
    const input: WebSerialWorkerControllerInput & { [workerSerialQualificationHook]: WorkerSerialQualificationHook } = {
      deviceFilter: { usbVendorId: 0x303a, usbProductId: 0x1001 }, trustedUpdateKeys: config.trust.updateAuthority.keys,
      continuityScope: { challengeId: "challenge_pending_serial_permission", retentionExpiryUnixSeconds: 1 },
      expectedFirmwareSourceCommit: config.expectedFirmwareSourceCommit, expectedAppElfSha256: config.expectedAppElfSha256,
      [workerSerialQualificationHook]: hook,
    };
    return createWebSerialWorkerController(input);
  },
  local: localJson, flush: flushRecoverySupervisor, highWater, publish,
  identity: () => ({ gateCommit, ...(maybeConfigurationFailure ? { configurationFailure: maybeConfigurationFailure } : {}), ...(maybeConfiguration ? { expectedFirmwareSourceCommit: maybeConfiguration.expectedFirmwareSourceCommit, expectedAppElfSha256: maybeConfiguration.expectedAppElfSha256 } : {}) }),
});

/** Only an explicit `restorationQualification` configuration enables this page; other modes are refused. */
function configure(input: unknown) {
  if (operations.state().connected) throw new Error("configuration_while_connected");
  const parsed = parseWorkerSerialAcceptanceConfiguration(input, gateCommit);
  if (parsed.restorationQualification !== true) throw new Error("restoration_mode_required");
  requireWorkerAcceptanceModeTransition(maybeConfiguration, parsed);
  maybeConfiguration = parsed;
  maybeConfigurationFailure = undefined;
  hook.allowClockDiscontinuityStimulus = true;
  operations.configured();
  return operations.state();
}

const { observeStatus: _observeStatus, observeAdmissionFailure: _admission, observeSerialFailure: _serial, observeDiagnostic: _diagnostic, configured: _configured, ...pageOperations } = operations;
export const workerRestoration = { ...pageOperations, configure };
Object.assign(window, { workerRestoration });
bindWorkerQualificationConnect(document.getElementById("connect"), () => true, operations.connect, async () => { publish(); });
publish();
void localJson("/context").then(configure).catch(() => { maybeConfigurationFailure = "configuration_failed"; publish(); });
