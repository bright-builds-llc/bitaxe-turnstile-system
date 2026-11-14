#!/usr/bin/env bun
/**
 * Gate negatives harness (Ticket 21). Drives the reference page in a test Chrome
 * over CDP and pauses the Authority's `/v0/challenges/{id}/work-session/{start,renew}`
 * responses with Fetch, to withhold a Start grant, hold one past the board's 60 s
 * unused context, or hand one tab's grant to another tab. Each attempt is then
 * cancelled through the page, and the harness checks that mining never started,
 * the Authority ended the attempt, no Gate Pass exists and the only board-bound
 * value the Authority saw was `control_session_binding_sha256`.
 *
 * Nothing here signs anything; grants are the Authority's own, moved or delayed.
 * Output names cases, routes as templates and field names, never endpoints, keys,
 * pool identities or values.
 *
 * Rehearsal (Ticket 06): `scripts/rehearse-production-path.sh --negatives`.
 * Deployment (Ticket 28), against a Chrome started with `--remote-debugging-port`:
 *   bun scripts/gate-negatives-harness.ts --browser http://127.0.0.1:9222 \
 *     --origin <deployment origin> --payout-address-file <file> \
 *     --board-values-file <file> [--cases withheld,expired_context,handed_over]
 * A person picks each tab's port when Chrome asks; the handover's second tab is the second board.
 * The board values file lists, one per line, values tied to the boards (Device Identity
 * fingerprints, firmware commit, ELF digest, MACs); the audit searches every request for them.
 * If a step fails, the harness still tries the page's Cancel so no challenge waits for expiry.
 */
import { parseArgs } from "node:util";
import { connectCdp, type CdpConnection } from "./cdp-connection";
import { auditAuthorityRequests, type AuditedRoute } from "./gate-negatives-audit";
import {
  CONTEXT_HOLD_MILLISECONDS,
  GATE_NEGATIVE_CASES,
  caseTabs,
  caseVerdict,
  parseGateNegativeCases,
  type CaseVerdict,
  type GateNegativeCase,
  type TabEvidence,
} from "./gate-negatives-cases";
import { deploymentAdapter, rehearsalAdapter, type DeploymentAdapter } from "./gate-negatives-adapters";
import { grantInterceptor } from "./gate-negatives-interceptor";
import { openHarnessTab, waitFor, type HarnessTab } from "./gate-negatives-tab";

const CONNECT_BUTTON = ["#connect-bitaxe"];
const PRIMARY_BUTTON = ["bwg-work-gate", "[data-action=primary]"];
const CANCEL_BUTTON = ["bwg-work-gate", "[data-action=cancel]"];
const CONFIRM_CANCEL_BUTTON = ["bwg-work-gate", "[data-action=confirm-cancel]"];
/** The page's rollback waits for the board's restoration, about 35 s on the fake and 47 s on a board. */
const ROLLBACK_MILLISECONDS = 120_000;
const LATE_EVENT_MILLISECONDS = 2_000;
const CLEANUP_MILLISECONDS = 15_000;

type CaseReport = {
  caseName: GateNegativeCase;
  boardValuesSearched: string[];
  verdict: CaseVerdict;
  tabs: TabEvidence[];
  routes: AuditedRoute[];
};

const options = await parseCommandLine();
const cdp = await connectCdp(options.browser);
try {
  const reports: CaseReport[] = [];
  for (const caseName of options.cases) {
    reports.push(await runCaseSafely(cdp, options.adapter, options.origin, caseName));
  }
  for (const report of reports) printReport(report, options.origin);
  const passed = reports.every((report) => report.verdict.passed);
  process.stdout.write(`negatives: ${passed ? "passed" : "failed"}\n`);
  process.exitCode = passed ? 0 : 1;
} finally {
  cdp.close();
}

async function runCaseSafely(
  connection: CdpConnection,
  adapter: DeploymentAdapter,
  origin: string,
  caseName: GateNegativeCase,
): Promise<CaseReport> {
  const tabs: HarnessTab[] = [];
  try {
    return await runCase(connection, adapter, origin, caseName, tabs);
  } catch (error) {
    const failures = [`harness step failed: ${errorText(error)}`, ...(await cancelLeftAttempts(tabs))];
    return {
      caseName,
      boardValuesSearched: [],
      tabs: [],
      routes: [],
      verdict: { passed: false, failures, startByTab: {} },
    };
  } finally {
    await Promise.allSettled(tabs.map((tab) => tab.close()));
  }
}

/** After a failed step, a deployment's challenge shouldn't be left waiting for its expiry. */
async function cancelLeftAttempts(tabs: readonly HarnessTab[]): Promise<string[]> {
  const outcomes: string[] = [];
  for (const tab of tabs) {
    if (tab.authorityStates.at(-1) === "cancelled") continue;
    try {
      await cancelThroughPage(tab, CLEANUP_MILLISECONDS);
      outcomes.push(`cleanup: tab ${tab.name} sent Cancel through the page`);
    } catch (error) {
      outcomes.push(`cleanup: tab ${tab.name} could not cancel (${errorText(error)}), so its challenge ends at expiry`);
    }
  }
  return outcomes;
}

async function runCase(
  connection: CdpConnection,
  adapter: DeploymentAdapter,
  origin: string,
  caseName: GateNegativeCase,
  tabs: HarnessTab[],
): Promise<CaseReport> {
  const interceptor = grantInterceptor(caseName);
  for (const name of caseTabs(caseName)) {
    const tab = await openHarnessTab(connection, name, interceptor.onPaused);
    tabs.push(tab);
    await adapter.load(tab, origin);
    await consentAndStart(tab, adapter);
    await waitFor(`tab ${name}'s Start grant to be paused`, () => interceptor.pausedStart(name), 60_000);
  }
  await waitFor("every altered grant to be answered", () => interceptor.settled(), CONTEXT_HOLD_MILLISECONDS + 30_000);
  for (const tab of tabs) await cancelThroughPage(tab, ROLLBACK_MILLISECONDS);
  for (const tab of tabs) await endedByAuthority(tab, adapter);
  await Bun.sleep(LATE_EVENT_MILLISECONDS);
  const evidence = await Promise.all(tabs.map(async (tab) => tabEvidence(tab, adapter, interceptor)));
  const audit = auditAuthorityRequests(tabs.flatMap((tab) => tab.requests), {
    origin,
    boardValues: adapter.boardValues.map((boardValue) => boardValue.value),
  });
  return {
    caseName,
    boardValuesSearched: adapter.boardValues.map((boardValue) => boardValue.label),
    verdict: caseVerdict(caseName, evidence, audit),
    tabs: evidence,
    routes: audit.routes,
  };
}

async function consentAndStart(tab: HarnessTab, adapter: DeploymentAdapter): Promise<void> {
  await tab.click(CONNECT_BUTTON);
  await waitFor(
    `tab ${tab.name}'s consent to be offered`,
    async () => {
      const state = await tab.elementState(PRIMARY_BUTTON);
      return state.visible && state.enabled;
    },
    adapter.connectTimeoutMilliseconds,
  );
  await tab.click(PRIMARY_BUTTON);
}

async function cancelThroughPage(tab: HarnessTab, offerTimeoutMilliseconds: number): Promise<void> {
  await waitFor(
    `tab ${tab.name}'s Cancel to be offered`,
    async () => {
      const state = await tab.elementState(CANCEL_BUTTON);
      return state.visible && state.enabled;
    },
    offerTimeoutMilliseconds,
  );
  await tab.click(CANCEL_BUTTON);
  await waitFor(`tab ${tab.name}'s Cancel confirmation`, async () => (await tab.elementState(CONFIRM_CANCEL_BUTTON)).visible, 10_000);
  await tab.click(CONFIRM_CANCEL_BUTTON);
}

async function endedByAuthority(tab: HarnessTab, adapter: DeploymentAdapter): Promise<void> {
  await waitFor(
    `tab ${tab.name}'s Authority to report the attempt cancelled`,
    () => tab.cancelAccepted() && tab.authorityStates.at(-1) === "cancelled",
    ROLLBACK_MILLISECONDS,
  );
  await adapter.settle(tab);
}

async function tabEvidence(
  tab: HarnessTab,
  adapter: DeploymentAdapter,
  interceptor: ReturnType<typeof grantInterceptor>,
): Promise<TabEvidence> {
  const maybeInterception = interceptor.interception(tab.name);
  const maybeBoard = await adapter.maybeBoard(tab);
  return {
    tab: tab.name,
    ...(maybeInterception ? { maybeInterception } : {}),
    authorityStates: [...tab.authorityStates],
    verifiedProgress: tab.verifiedProgress(),
    progressEvents: tab.progressEvents(),
    resyncRequired: tab.resyncRequired(),
    recorderErrors: [...tab.recorderErrors],
    cancelAccepted: tab.cancelAccepted(),
    gatePassRequests: tab.gatePassRequests(),
    ...(maybeBoard ? { maybeBoard } : {}),
  };
}

function printReport(report: CaseReport, origin: string): void {
  const { caseName, verdict } = report;
  const evidence = {
    startByTab: verdict.startByTab,
    boardValuesSearched: report.boardValuesSearched,
    tabs: report.tabs,
    routes: report.routes,
  };
  const lines = [
    `${caseName} ${verdict.passed ? "passed" : "failed"}`,
    `${caseName} evidence ${JSON.stringify(evidence)}`,
    ...verdict.failures.map((failure) => `${caseName} failure ${failure}`),
  ];
  for (const line of lines) process.stdout.write(`negatives: ${redact(line, origin)}\n`);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Error text can quote a URL; the record names no endpoints. */
function redact(text: string, origin: string): string {
  return text.replaceAll(origin, "<origin>").replace(/\b(?:https?|wss?):\/\/[^\s"')]+/gu, "<url>");
}

async function parseCommandLine() {
  const { values } = parseArgs({
    options: {
      browser: { type: "string" },
      origin: { type: "string" },
      cases: { type: "string", default: GATE_NEGATIVE_CASES.join(",") },
      rehearsal: { type: "boolean", default: false },
      page: { type: "string", default: "/reference/account-creation.html" },
      "payout-address-file": { type: "string" },
      "board-values-file": { type: "string" },
      "connect-timeout-seconds": { type: "string", default: "600" },
    },
  });
  if (!values.browser || !values.origin) {
    throw new Error("usage: gate-negatives-harness --browser <DevTools endpoint> --origin <deployment origin> (--rehearsal | --payout-address-file <file> --board-values-file <file>)");
  }
  const origin = new URL(values.origin).origin;
  const cases = parseGateNegativeCases(values.cases);
  const adapter = values.rehearsal ? rehearsalAdapter() : deploymentFromOptions(values);
  return { browser: values.browser, origin, cases, adapter: await adapter };
}

function deploymentFromOptions(values: {
  page: string;
  "payout-address-file"?: string;
  "board-values-file"?: string;
  "connect-timeout-seconds": string;
}): Promise<DeploymentAdapter> {
  const payoutAddressFile = values["payout-address-file"];
  if (!payoutAddressFile) throw new Error("a deployment run needs --payout-address-file");
  // Without board values the audit's board-value search would pass having searched for nothing.
  const boardValuesFile = values["board-values-file"];
  if (!boardValuesFile) throw new Error("a deployment run needs --board-values-file");
  return deploymentAdapter({
    pagePath: values.page,
    payoutAddressFile,
    boardValuesFile,
    connectTimeoutMilliseconds: Number(values["connect-timeout-seconds"]) * 1000,
  });
}
