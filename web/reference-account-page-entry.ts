/**
 * Entry for `reference/account-creation.html`. The deployment fills the page's
 * `bwg-reference-config` JSON with its public Gate Pass trust and the board's
 * Worker Serial trust; the page holds no secrets.
 */
import { registerBwgWorkGate, type BwgWorkGateElement } from "./bwg-work-gate";
import { connectReferenceAccountPage, type ReferencePageConfig } from "./reference-account-page";
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
if (!configElement?.textContent || !gate || !payout || !connect || !status) {
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
    worker: (scope) => ({
      ...deployment.worker,
      continuityScope: {
        challengeId: scope.challengeId,
        retentionExpiryUnixSeconds: scope.expiresAtUnixSeconds,
      },
    }),
  }).then(
    () => {
      status.textContent =
        "Connected. You can switch tabs or minimize this window; keep this page open until restoration is confirmed.";
    },
    (error: unknown) => {
      connect.disabled = false;
      status.textContent = error instanceof Error ? error.message : "Connection failed";
    },
  );
});
