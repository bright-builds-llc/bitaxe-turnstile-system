/**
 * Where the Gate negatives harness runs: the production-path rehearsal (Ticket 06),
 * whose fake board it can read, or a deployment with real boards (Ticket 28),
 * where only the page and the Authority are visible and a person picks each port.
 */
import { readFile } from "node:fs/promises";
import possessionFixture from "../conformance/bwg-worker-possession-0.2/fixtures.json";
import { rehearsalBoardValues } from "../web/production-path-rehearsal-device";
import type { BoardEvidence } from "./gate-negatives-cases";
import { waitFor, type HarnessTab } from "./gate-negatives-tab";

/** A value tied to the board, searched for in every request; only its label is ever printed. */
export type BoardValue = { label: string; value: string };

export type DeploymentAdapter = {
  pagePath: string;
  boardValues: BoardValue[];
  /** The payout destination the page entered, which the audit allows only in the pool selection. */
  payoutDestination(): string;
  /** The Device Identity fingerprints the tab's page holds once its board is admitted; never printed. */
  deviceIdentityFingerprints(tab: HarnessTab): Promise<string[]>;
  /** How long a person may take to pick the port and the page to show consent. */
  connectTimeoutMilliseconds: number;
  /** Opens the page in `tab`, ready for the Connect click. */
  load(tab: HarnessTab, origin: string): Promise<void>;
  /** Waits for whatever confirms the board's restoration, where the harness can see it. */
  settle(tab: HarnessTab): Promise<void>;
  maybeBoard(tab: HarnessTab): Promise<BoardEvidence | undefined>;
};

const REHEARSAL_PAGE = "/reference/production-path-rehearsal.html";
const MINER_BINDING = "bwgHarnessMinerStart";

type RehearsalDevice = {
  commands: string[];
  leasesStarted: number;
  startRejections: string[];
  restorationReason: string | undefined;
  portClosed: boolean;
};

/** The rehearsal page with its fake board; the CPU miner is never wired, since no case may mine. */
export async function rehearsalAdapter(): Promise<DeploymentAdapter> {
  const minerStarts = new Map<string, number>();
  let maybePayoutDestination: string | undefined;
  return {
    pagePath: REHEARSAL_PAGE,
    boardValues: await rehearsalBoardValues(),
    payoutDestination() {
      if (!maybePayoutDestination) throw new Error("the rehearsal page has not served its payout address yet");
      return maybePayoutDestination;
    },
    // The rehearsal keeps continuity in memory, so its fake board's fingerprint comes from the fixture it signs with.
    deviceIdentityFingerprints: async () => [possessionFixture.fixtureIdentity.fingerprintSha256],
    connectTimeoutMilliseconds: 30_000,
    async load(tab, origin) {
      minerStarts.set(tab.name, 0);
      tab.on("Runtime.bindingCalled", (params) => {
        if (params.name === MINER_BINDING) minerStarts.set(tab.name, (minerStarts.get(tab.name) ?? 0) + 1);
      });
      await tab.send("Runtime.addBinding", { name: MINER_BINDING });
      await tab.navigate(`${origin}${REHEARSAL_PAGE}`);
      const served = await tab.evaluate(async () => (await fetch("/rehearsal-config")).json() as Promise<Record<string, unknown>>);
      if (typeof served.payoutAddress !== "string") throw new Error("the rehearsal config has no payout address");
      maybePayoutDestination = served.payoutAddress;
      await tab.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `(${installRehearsalPage.toString()})(${JSON.stringify(rehearsalPageConfig(served))}, ${JSON.stringify(MINER_BINDING)})`,
      });
      await tab.reload();
    },
    async settle(tab) {
      // A refused Start makes the page fail closed and drop the port, so there is no Cancel to confirm.
      await waitFor(
        `tab ${tab.name}'s board to confirm restoration or lose its port`,
        async () => {
          const maybeDevice = await rehearsalDevice(tab);
          return maybeDevice?.restorationReason === "cancelled" || maybeDevice?.portClosed === true;
        },
        60_000,
      );
    },
    async maybeBoard(tab) {
      const maybeDevice = await rehearsalDevice(tab);
      if (!maybeDevice) return undefined;
      return {
        startLeaseCommands: maybeDevice.commands.filter((command) => command === "start_lease").length,
        leasesStarted: maybeDevice.leasesStarted,
        startRejections: maybeDevice.startRejections,
        minerStarts: minerStarts.get(tab.name) ?? 0,
        restorationReason: maybeDevice.restorationReason,
        portClosed: maybeDevice.portClosed,
      };
    },
  };
}

/**
 * A deployed reference page; the payout address and board values come from the owner's files. The
 * board values file holds one value per line (Device Identity fingerprint, firmware commit, ELF
 * digest, MAC and the like) and must not be empty, or the board-value search would check nothing.
 */
export async function deploymentAdapter(input: {
  pagePath: string;
  payoutAddressFile: string;
  boardValuesFile: string;
  connectTimeoutMilliseconds: number;
}): Promise<DeploymentAdapter> {
  const payoutAddress = (await readFile(input.payoutAddressFile, "utf8")).trim();
  const boardValues = (await readFile(input.boardValuesFile, "utf8"))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((value, index) => ({ label: `board values file line ${index + 1}`, value }));
  if (boardValues.length === 0) throw new Error("the board values file lists no values");
  return {
    pagePath: input.pagePath,
    boardValues,
    payoutDestination: () => payoutAddress,
    deviceIdentityFingerprints: async (tab) => await tab.evaluate(storedDeviceIdentityFingerprints),
    connectTimeoutMilliseconds: input.connectTimeoutMilliseconds,
    async load(tab, origin) {
      await tab.navigate(`${origin}${input.pagePath}`);
      await tab.evaluate((address: string) => {
        const field = document.querySelector<HTMLInputElement>("#payout-address");
        if (!field) throw new Error("the page has no payout address field");
        field.value = address;
        field.dispatchEvent(new Event("input", { bubbles: true }));
      }, payoutAddress);
    },
    // A person reads the board's own log for its restoration; the page's Cancel and the Authority are checked.
    settle: async () => undefined,
    maybeBoard: async () => undefined,
  };
}

/**
 * Runs in the page: the fingerprints in its private `bwg-worker` continuity store, which the page
 * writes on admission and clears when the attempt ends. Self-contained, since it's sent as source.
 */
async function storedDeviceIdentityFingerprints(): Promise<string[]> {
  const known = await indexedDB.databases();
  if (!known.some((database) => database.name === "bwg-worker")) return [];
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("bwg-worker");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    if (!database.objectStoreNames.contains("continuity")) return [];
    const records = await new Promise<unknown[]>((resolve, reject) => {
      const request = database.transaction("continuity", "readonly").objectStore("continuity").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return records.flatMap((record) => {
      const maybeFingerprint = (record as { deviceIdentityFingerprint?: unknown } | null)?.deviceIdentityFingerprint;
      return typeof maybeFingerprint === "string" ? [maybeFingerprint] : [];
    });
  } finally {
    database.close();
  }
}

function rehearsalPageConfig(served: Record<string, unknown>) {
  return {
    authorityTrust: served.authorityTrust,
    payoutAddress: served.payoutAddress,
    workers: [{ workerId: "rehearsal-cpu", displayName: "Rehearsal CPU miner", hashrateHs: "1000000" }],
    claimantWorkCeiling: "281474976710656",
    clientSafetyCeiling: "281474976710656",
    provenance: {
      sourceUrl: "https://github.com/bright-builds-llc/bitaxe-turnstile-system",
      protocolVersion: "BWG/0.1",
      appVersion: "rehearsal",
    },
  };
}

/** Runs in the page before its entry: the rehearsal config, and a miner bridge that only reports a start. */
function installRehearsalPage(config: unknown, bindingName: string): void {
  const page = window as unknown as Record<string, unknown>;
  page.bwgRehearsalConfig = config;
  page.bwgRehearsalMiner = async (command: string) => {
    if (command === "start") (page[bindingName] as (payload: string) => void)("start");
  };
}

async function rehearsalDevice(tab: HarnessTab): Promise<RehearsalDevice | undefined> {
  return await tab.evaluate(() => {
    const maybeDevice = (window as unknown as { bwgRehearsal?: { maybeDevice?: RehearsalDevice } }).bwgRehearsal?.maybeDevice;
    return maybeDevice ? structuredClone(maybeDevice) : undefined;
  });
}
