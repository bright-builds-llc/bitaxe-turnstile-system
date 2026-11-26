/**
 * Rehearsal entry (Ticket 06): the reference page with the fake serial Worker.
 * `scripts/run-production-path-rehearsal.mjs` injects `bwgRehearsalConfig` and the
 * `bwgRehearsalMiner` bridge to the local CPU miner. Test keys only.
 */
import { registerBwgWorkGate, type BwgWorkGateElement } from "./bwg-work-gate";
import type { HeadlessEvent } from "./headless-client";
import {
  rehearsalWorkerInput,
  type RehearsalDeviceLog,
} from "./production-path-rehearsal-device";
import { acquireWorkerSerialLock } from "./webserial-worker-port";
import {
  connectReferenceAccountPage,
  connectStandardWorkerReferencePage,
  type ReferencePageConfig,
  type ReferencePageEvent,
} from "./reference-account-page";
import { renderStandardWorkerSettings } from "./standard-worker-settings-view";

type RehearsalWindow = Window & {
  bwgRehearsalConfig: Omit<ReferencePageConfig, "origin"> & { payoutAddress: string };
  bwgRehearsalMiner(command: "start" | "stop", body?: unknown): Promise<void>;
  bwgRehearsal: {
    pageEvents: ReferencePageEvent[];
    clientEvents: HeadlessEvent[];
    maybeDevice?: RehearsalDeviceLog;
    maybeError?: string;
    /** The redemption request, so the runner can prove a replay is refused. */
    maybeRedemptionBody?: string;
    /** For the standard Worker: whether settings were shown, in order, as true for shown. */
    standardSettingsShown: boolean[];
  };
};

registerBwgWorkGate();
const page = window as unknown as RehearsalWindow;
const state: RehearsalWindow["bwgRehearsal"] = { pageEvents: [], clientEvents: [], standardSettingsShown: [] };
page.bwgRehearsal = state;
const pageFetch = window.fetch.bind(window);
window.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input).endsWith("/account-creation/redeem") && typeof init?.body === "string") {
    state.maybeRedemptionBody = init.body;
  }
  return pageFetch(input, init);
}, { preconnect: window.fetch.preconnect });
const gate = document.querySelector<BwgWorkGateElement>("bwg-work-gate");
const connect = document.querySelector<HTMLButtonElement>("#connect-bitaxe");
const useStratumWorker = document.querySelector<HTMLButtonElement>("#use-stratum-worker");
const stratumSettings = document.querySelector<HTMLElement>("#stratum-settings");
if (!gate || !connect || !useStratumWorker || !stratumSettings) throw new Error("rehearsal page markup is incomplete");
const recordFailure = (error: unknown) => {
  state.maybeError = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
};
connect.addEventListener("click", () => {
  connect.disabled = true;
  const { payoutAddress, ...config } = page.bwgRehearsalConfig;
  connectReferenceAccountPage({
    config: { ...config, origin: window.location.origin },
    gate,
    payoutAddress,
    worker() {
      const { worker, log } = rehearsalWorkerInput({
        miner: {
          start: (stratum) => page.bwgRehearsalMiner("start", stratum),
          stop: () => page.bwgRehearsalMiner("stop"),
        },
        acquireLock: () => acquireWorkerSerialLock(navigator.locks),
      });
      state.maybeDevice = log;
      return worker;
    },
    maybeOnEvent: (event) => state.pageEvents.push(event),
  }).then(
    (client) => {
      client.subscribe((event) => state.clientEvents.push(event));
    },
    (error: unknown) => {
      state.maybeError = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
    },
  );
});

// The standard Worker path: the runner reads the shown settings and configures the CPU miner with them,
// as a claimant types them into their own Worker.
useStratumWorker.addEventListener("click", () => {
  connect.disabled = true;
  useStratumWorker.disabled = true;
  const { payoutAddress, ...config } = page.bwgRehearsalConfig;
  connectStandardWorkerReferencePage({
    config: { ...config, origin: window.location.origin },
    gate,
    payoutAddress,
    maybeOnEvent: (event) => state.pageEvents.push(event),
  }).then(({ client, worker }) => {
    client.subscribe((event) => state.clientEvents.push(event));
    worker.subscribe((maybeSettings) => {
      state.standardSettingsShown.push(maybeSettings !== undefined);
      renderStandardWorkerSettings(stratumSettings, maybeSettings);
    });
  }, recordFailure);
});
