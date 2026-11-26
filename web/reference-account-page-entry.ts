/**
 * Entry for `reference/account-creation.html`. The deployment fills the page's
 * `bwg-reference-config` JSON with its public Gate Pass trust and the board's
 * Worker Serial trust; the page holds no secrets.
 */
import { registerBwgWorkGate, type BwgWorkGateElement } from "./bwg-work-gate";
import {
  connectFailureMessage,
  connectReferenceAccountPage,
  connectStandardWorkerReferencePage,
  type ReferencePageConfig,
} from "./reference-account-page";
import { renderStandardWorkerSettings } from "./standard-worker-settings-view";
import type { WebSerialWorkerControllerInput } from "./webserial-worker-controller";

type DeploymentConfig = Omit<ReferencePageConfig, "origin"> & {
  worker: Omit<WebSerialWorkerControllerInput, "continuityScope">;
};

registerBwgWorkGate();
const configElement = document.querySelector("#bwg-reference-config");
const gate = document.querySelector<BwgWorkGateElement>("bwg-work-gate");
const payout = document.querySelector<HTMLInputElement>("#payout-address");
const connect = document.querySelector<HTMLButtonElement>("#connect-bitaxe");
const status = document.querySelector<HTMLElement>("#connect-status");
const useStratumWorker = document.querySelector<HTMLButtonElement>("#use-stratum-worker");
const stratumSettings = document.querySelector<HTMLElement>("#stratum-settings");
if (!configElement?.textContent || !gate || !payout || !connect || !status || !useStratumWorker || !stratumSettings) {
  throw new Error("reference page markup is incomplete");
}
const deployment = JSON.parse(configElement.textContent) as DeploymentConfig;
connect.addEventListener("click", () => {
  connect.disabled = true;
  status.textContent = "Connecting";
  connectReferenceAccountPage({
    config: { ...deployment, origin: window.location.origin },
    gate,
    payoutAddress: payout.value.trim(),
    worker: () => deployment.worker,
    maybeOnEvent: (event) => {
      if (event.type === "released") status.textContent = "Restoration confirmed and the USB port released; you can close this page.";
      if (event.type === "release_failed") status.textContent = `The USB port was not released: ${event.message}`;
    },
  }).then(
    () => {
      status.textContent =
        "Connected. You can switch tabs or minimize this window; keep this page open until restoration is confirmed.";
    },
    (error: unknown) => {
      connect.disabled = false;
      status.textContent = connectFailureMessage(error);
    },
  );
});

// Offered only when the deployment configures a standard Worker; its settings stop working when the lease ends.
useStratumWorker.hidden = deployment.maybeStandardWorker === undefined;
useStratumWorker.addEventListener("click", () => {
  connect.disabled = true;
  useStratumWorker.disabled = true;
  status.textContent = "Preparing";
  connectStandardWorkerReferencePage({
    config: { ...deployment, origin: window.location.origin },
    gate,
    payoutAddress: payout.value.trim(),
    maybeOnEvent: (event) => {
      if (event.type === "redeemed" && event.status === 200) {
        status.textContent = "Done. Point your Worker back at its usual pool; these settings no longer work.";
      }
    },
  }).then(
    ({ worker }) => {
      worker.subscribe((maybeSettings) => renderStandardWorkerSettings(stratumSettings, maybeSettings));
      status.textContent = "Review the terms, then start. Keep this page open while your Worker mines.";
    },
    (error: unknown) => {
      connect.disabled = false;
      useStratumWorker.disabled = false;
      status.textContent = connectFailureMessage(error);
    },
  );
});
