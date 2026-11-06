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
import {
  connectReferenceAccountPage,
  type ReferencePageConfig,
  type ReferencePageEvent,
} from "./reference-account-page";

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
  };
};

registerBwgWorkGate();
const page = window as unknown as RehearsalWindow;
const state: RehearsalWindow["bwgRehearsal"] = { pageEvents: [], clientEvents: [] };
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
if (!gate || !connect) throw new Error("rehearsal page markup is incomplete");
connect.addEventListener("click", () => {
  connect.disabled = true;
  const { payoutAddress, ...config } = page.bwgRehearsalConfig;
  connectReferenceAccountPage({
    config: { ...config, origin: window.location.origin },
    gate,
    payoutAddress,
    worker(scope) {
      const { worker, log } = rehearsalWorkerInput({
        challengeId: scope.challengeId,
        retentionExpiryUnixSeconds: scope.expiresAtUnixSeconds,
        miner: {
          start: (stratum) => page.bwgRehearsalMiner("start", stratum),
          stop: () => page.bwgRehearsalMiner("stop"),
        },
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
