#!/usr/bin/env bun
/**
 * The self-host proof's claimant (bwg-core Ticket 24). It drives a self-hosted deployment's own
 * page in a test Chrome over CDP, with no rehearsal hooks: it chooses the standard Stratum V1
 * Worker, gives consent, reads the settings the page shows and hands them to a CPU miner as a
 * person would type them into their Worker. Once real shares have moved the challenge's progress
 * and the page has renewed its Work Lease, it cancels through the page and checks that the page
 * withdraws the settings and the Pool Adapter cuts the miner off.
 *
 * Regtest's CPU miner can't reach the Standard policy's Work Requirement, so this journey never
 * reaches a Gate Pass; `scripts/rehearse-production-path.sh --standard-worker` covers that.
 * It prints one evidence line naming counts and states, never the settings, endpoints or keys.
 *
 * Usage: bun scripts/self-host-journey.ts --browser <DevTools endpoint> --origin <origin>
 *          --payout-address <address> --miner-control http://127.0.0.1:PORT
 */
import { parseArgs } from "node:util";
import { connectCdp } from "./cdp-connection";
import { openHarnessTab, waitFor, type ElementPath, type HarnessTab } from "./gate-negatives-tab";

const PAGE = "/reference/account-creation.html";
const STANDARD_WORKER_BUTTON = ["#use-stratum-worker"];
const SETTINGS = ["#stratum-settings"];
const PRIMARY_BUTTON = ["bwg-work-gate", "[data-action=primary]"];
const CANCEL_BUTTON = ["bwg-work-gate", "[data-action=cancel]"];
const CONFIRM_CANCEL_BUTTON = ["bwg-work-gate", "[data-action=confirm-cancel]"];
const CONSENT_WORKERS = ["bwg-work-gate", "[data-field=workers]"];
/** Two lease windows of real shares and a Renew, well inside a challenge's 15 minutes. */
const WORK_MILLISECONDS = 240_000;
/** A lease's credentials last at most 60 s, and the proxy rereads its registration every 5 s. */
const CUT_OFF_MILLISECONDS = 120_000;

type MinerStats = { running: boolean; accepted: number; rejected: number };

const { values } = parseArgs({
  options: {
    browser: { type: "string" },
    origin: { type: "string" },
    "payout-address": { type: "string" },
    "miner-control": { type: "string" },
  },
});
if (!values.browser || !values.origin || !values["payout-address"] || !values["miner-control"]) {
  throw new Error("usage: self-host-journey --browser <endpoint> --origin <origin> --payout-address <address> --miner-control <url>");
}
const origin = new URL(values.origin).origin;
const minerControl = values["miner-control"];
const payoutAddress = values["payout-address"];

async function miner(): Promise<MinerStats> {
  const response = await fetch(`${minerControl}/miner`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`the CPU miner's control answered ${response.status}`);
  return (await response.json()) as MinerStats;
}

async function startMiner(settings: { endpoint: string; username: string; password: string }): Promise<void> {
  const response = await fetch(`${minerControl}/miner/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(settings),
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status !== 204) throw new Error(`the CPU miner refused its settings with ${response.status}`);
}

async function clickWhenOffered(tab: HarnessTab, path: ElementPath, label: string, timeoutMilliseconds: number): Promise<void> {
  await waitFor(
    label,
    async () => {
      const state = await tab.elementState(path);
      return state.visible && state.enabled;
    },
    timeoutMilliseconds,
  );
  await tab.click(path);
}

async function shownSettings(tab: HarnessTab) {
  if (!(await tab.elementState(SETTINGS)).visible) return undefined;
  const field = async (name: string) => (await tab.text([`#stratum-settings [data-field=${name}]`]))?.trim() ?? "";
  const settings = { endpoint: await field("endpoint"), username: await field("username"), password: await field("password") };
  return settings.endpoint && settings.username && settings.password ? settings : undefined;
}

const renewals = (tab: HarnessTab) =>
  tab.requests.filter((request) => request.method === "POST" && new URL(request.url).pathname.endsWith("/work-session/renew")).length;

const cdp = await connectCdp(values.browser);
// The journey alters no grant; every paused response goes on as the Authority sent it.
const tab = await openHarnessTab(cdp, "self-host", (pausedTab, event) => {
  void pausedTab.send("Fetch.continueRequest", { requestId: event.requestId });
});
try {
  await tab.navigate(`${origin}${PAGE}`);
  await tab.evaluate((address: string) => {
    const field = document.querySelector<HTMLInputElement>("#payout-address");
    if (!field) throw new Error("the page has no payout address field");
    field.value = address;
    field.dispatchEvent(new Event("input", { bubbles: true }));
  }, payoutAddress);
  await clickWhenOffered(tab, STANDARD_WORKER_BUTTON, "the standard Worker to be offered", 30_000);
  await waitFor(
    "consent to be offered",
    async () => {
      const state = await tab.elementState(PRIMARY_BUTTON);
      return state.visible && state.enabled;
    },
    60_000,
  );
  const consentWorkers = ((await tab.text(CONSENT_WORKERS)) ?? "").split(", ").map((worker) => worker.trim()).filter(Boolean);
  await tab.click(PRIMARY_BUTTON);
  const settings = await waitFor("the page to show the lease's settings", () => shownSettings(tab), 60_000);
  await startMiner(settings);

  const startedAt = Date.now();
  await waitFor(
    "real shares to move progress past a Renew",
    async () => BigInt(tab.verifiedProgress()) > 0n && renewals(tab) >= 1 && (await miner()).accepted > 0,
    WORK_MILLISECONDS,
  );
  const beforeCancel = await miner();
  const progressBeforeCancel = tab.verifiedProgress();
  const workedSeconds = Math.round((Date.now() - startedAt) / 1000);

  await clickWhenOffered(tab, CANCEL_BUTTON, "Cancel to be offered", 10_000);
  await clickWhenOffered(tab, CONFIRM_CANCEL_BUTTON, "the Cancel confirmation", 10_000);
  const cancelledAt = Date.now();
  await waitFor("the Authority to report the attempt cancelled", () => tab.cancelAccepted() && tab.authorityStates.at(-1) === "cancelled", 60_000);
  await waitFor("the page to withdraw the settings", async () => !(await tab.elementState(SETTINGS)).visible, 30_000);
  const cutOffSeconds = await waitFor(
    "the Pool Adapter to cut the miner off",
    async () => ((await miner()).running ? undefined : Math.round((Date.now() - cancelledAt) / 1000)),
    CUT_OFF_MILLISECONDS,
  );
  const evidence = {
    consentWorkers,
    workedSeconds,
    renewals: renewals(tab),
    progressBeforeCancel,
    acceptedBeforeCancel: beforeCancel.accepted,
    rejectedBeforeCancel: beforeCancel.rejected,
    authorityStates: [...new Set(tab.authorityStates)],
    gatePassRequests: tab.gatePassRequests(),
    settingsWithdrawn: true,
    cutOffAfterCancelSeconds: cutOffSeconds,
    recorderErrors: tab.recorderErrors.length,
  };
  process.stdout.write(`self-host journey ${JSON.stringify(evidence)}\n`);
  if (tab.recorderErrors.length > 0 || tab.gatePassRequests() !== 0) {
    throw new Error("the journey's tab recorded errors, or a Gate Pass was asked for after Cancel");
  }
} finally {
  await tab.close();
  cdp.close();
}
