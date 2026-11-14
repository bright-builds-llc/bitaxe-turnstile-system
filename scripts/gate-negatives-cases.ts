/**
 * The Gate negatives (Ticket 21): what the harness does to each intercepted
 * Worker Lease grant, and how it judges the attempt afterwards. Pure; the CDP
 * shell in `gate-negatives-harness.ts` carries the decisions out.
 */
import { UNUSED_WORKER_LEASE_CONTEXT_MILLISECONDS } from "../web/worker-lease-admission";

export const GATE_NEGATIVE_CASES = ["withheld", "expired_context", "handed_over"] as const;
export type GateNegativeCase = (typeof GATE_NEGATIVE_CASES)[number];

/** Longer than the board's 60 s unused context, measured from the paused Start response. */
export const CONTEXT_HOLD_MILLISECONDS = UNUSED_WORKER_LEASE_CONTEXT_MILLISECONDS + 5_000;

export type GrantOperation = "start" | "renew";

/** One Authority grant response the browser has paused at the response stage. */
export type PausedGrant = {
  key: string;
  tab: string;
  operation: GrantOperation;
  pausedAtMilliseconds: number;
};

export type GrantDecision =
  | { type: "pass"; key: string }
  | { type: "withhold"; key: string }
  /** Answer `key` with the grant paused as `fromKey`, no earlier than the given time. */
  | { type: "deliver"; key: string; fromKey: string; notBeforeMilliseconds: number };

export type InterceptionState = {
  handledTabs: readonly string[];
  maybeWaiting?: PausedGrant;
};

export type InterceptionAction = "withheld" | "held" | "handed_over";

export type BoardEvidence = {
  /** `start_lease` commands the board received. */
  startLeaseCommands: number;
  leasesStarted: number;
  startRejections: string[];
  minerStarts: number;
  restorationReason: string | undefined;
  /** The page closed the port; the board stops on link loss, and never mined here. */
  portClosed: boolean;
};

/** What one tab's attempt showed; `maybeBoard` exists only where the harness can read the board. */
export type TabEvidence = {
  tab: string;
  maybeInterception?: { action: InterceptionAction; heldMilliseconds: number };
  authorityStates: string[];
  verifiedProgress: string;
  /** `verified_progress` events received; the stream's snapshot sends one, so 0 means progress is unknown. */
  progressEvents: number;
  /** The stream reported skipped updates, so a progress update may be missing. */
  resyncRequired: boolean;
  /** Failures inside the harness's own event handlers; any one leaves the evidence incomplete. */
  recorderErrors: string[];
  cancelAccepted: boolean;
  gatePassRequests: number;
  maybeBoard?: BoardEvidence;
};

export type StartOutcome = "never_reached_board" | "board_refused" | "unobserved";

export type CaseVerdict = {
  passed: boolean;
  failures: string[];
  startByTab: Record<string, StartOutcome>;
};

const EXPECTED_ACTION: Record<GateNegativeCase, InterceptionAction> = {
  withheld: "withheld",
  expired_context: "held",
  handed_over: "handed_over",
};

const ACTION_NAMES: Record<InterceptionAction, string> = {
  withheld: "withheld",
  held: "held",
  handed_over: "handed over",
};

export function parseGateNegativeCases(input: string): GateNegativeCase[] {
  return input.split(",").map((name) => {
    const maybeCase = GATE_NEGATIVE_CASES.find((known) => known === name.trim());
    if (!maybeCase) throw new Error(`unknown case ${JSON.stringify(name)}`);
    return maybeCase;
  });
}

/** The tabs a case drives; a handover needs a second tab, which in Ticket 28 is the second board. */
export function caseTabs(caseName: GateNegativeCase): readonly string[] {
  return caseName === "handed_over" ? ["a", "b"] : ["a"];
}

export function emptyInterceptionState(): InterceptionState {
  return { handledTabs: [] };
}

/** Decides what happens to a paused grant; each tab's first Start grant is the one the case alters. */
export function decideGrant(
  caseName: GateNegativeCase,
  state: InterceptionState,
  grant: PausedGrant,
): { state: InterceptionState; decisions: GrantDecision[] } {
  if (grant.operation !== "start" || state.handledTabs.includes(grant.tab)) {
    return { state, decisions: [{ type: "pass", key: grant.key }] };
  }
  const handledTabs = [...state.handledTabs, grant.tab];
  if (caseName === "withheld") {
    return { state: { ...state, handledTabs }, decisions: [{ type: "withhold", key: grant.key }] };
  }
  if (caseName === "expired_context") {
    const notBeforeMilliseconds = grant.pausedAtMilliseconds + CONTEXT_HOLD_MILLISECONDS;
    return {
      state: { ...state, handledTabs },
      decisions: [{ type: "deliver", key: grant.key, fromKey: grant.key, notBeforeMilliseconds }],
    };
  }
  const maybeWaiting = state.maybeWaiting;
  if (!maybeWaiting) return { state: { handledTabs, maybeWaiting: grant }, decisions: [] };
  const at = grant.pausedAtMilliseconds;
  return {
    state: { handledTabs },
    decisions: [
      { type: "deliver", key: grant.key, fromKey: maybeWaiting.key, notBeforeMilliseconds: at },
      { type: "deliver", key: maybeWaiting.key, fromKey: grant.key, notBeforeMilliseconds: at },
    ],
  };
}

/** Judges one case: mining never started, the page and Authority ended it, and no Gate Pass exists. */
export function caseVerdict(
  caseName: GateNegativeCase,
  tabs: readonly TabEvidence[],
  audit: { violations: readonly string[]; startBindingsByTab: Readonly<Record<string, readonly string[]>> },
): CaseVerdict {
  const failures = tabs.flatMap((tab) => [
    ...attemptFailures(caseName, tab),
    // Without a recorded Start the audit has checked nothing that matters, whatever else it found.
    ...(audit.startBindingsByTab[tab.tab]?.length ? [] : [`tab ${tab.tab}: the audit saw no Start carrying a control-session binding`]),
    ...boardFailures(caseName, tab),
  ]);
  if (caseName === "handed_over" && !distinctBindings(tabs, audit.startBindingsByTab)) {
    failures.push("the two tabs' control-session bindings are not distinct");
  }
  failures.push(...audit.violations);
  const startByTab = Object.fromEntries(tabs.map((tab) => [tab.tab, startOutcome(tab)]));
  return { passed: failures.length === 0, failures, startByTab };
}

function attemptFailures(caseName: GateNegativeCase, tab: TabEvidence): string[] {
  const failures: string[] = [];
  const expected = EXPECTED_ACTION[caseName];
  if (tab.maybeInterception?.action !== expected) {
    failures.push(`the Start grant was not ${ACTION_NAMES[expected]}`);
  }
  if (
    caseName === "expired_context" &&
    tab.maybeInterception &&
    tab.maybeInterception.heldMilliseconds < UNUSED_WORKER_LEASE_CONTEXT_MILLISECONDS
  ) {
    failures.push("the grant was held for less than the board's 60 s context");
  }
  for (const error of tab.recorderErrors) failures.push(`the recorder failed: ${error}`);
  if (tab.progressEvents === 0) failures.push("no verified_progress event arrived, so progress is unknown");
  if (tab.resyncRequired) failures.push("the event stream skipped updates (resync_required)");
  if (tab.verifiedProgress !== "0") failures.push("the Authority reported Verified Progress");
  for (const state of ["satisfied", "pass_issued"]) {
    if (tab.authorityStates.includes(state)) failures.push(`the Authority reached ${state}`);
  }
  if (tab.authorityStates.at(-1) !== "cancelled") failures.push("the Authority did not end the attempt as cancelled");
  if (!tab.cancelAccepted) failures.push("the Authority did not accept the page's Cancel");
  if (tab.gatePassRequests > 0) failures.push("the page asked for or redeemed a Gate Pass");
  return failures.map((failure) => `tab ${tab.tab}: ${failure}`);
}

function boardFailures(caseName: GateNegativeCase, tab: TabEvidence): string[] {
  const board = tab.maybeBoard;
  if (!board) return [];
  const failures: string[] = [];
  if (board.leasesStarted > 0) failures.push("the board started a lease");
  if (board.minerStarts > 0) failures.push("the miner was started");
  if (board.restorationReason === undefined && !board.portClosed) {
    failures.push("the board neither confirmed restoration nor lost its port");
  }
  if (caseName === "withheld" && board.startLeaseCommands > 0) failures.push("a withheld grant reached the board");
  if (caseName === "expired_context" && !onlyRejection(board, "admission_required")) {
    failures.push("the board did not refuse the Start for its expired context");
  }
  if (caseName === "handed_over" && board.startLeaseCommands > 0 && !onlyRejection(board, "authentication_failed")) {
    failures.push("the board did not refuse the other tab's grant as unauthenticated");
  }
  return failures.map((failure) => `tab ${tab.tab}: ${failure}`);
}

function onlyRejection(board: BoardEvidence, category: string): boolean {
  return board.startRejections.length === 1 && board.startRejections[0] === category;
}

function distinctBindings(
  tabs: readonly TabEvidence[],
  startBindingsByTab: Readonly<Record<string, readonly string[]>>,
): boolean {
  const firstBindings = tabs.map((tab) => startBindingsByTab[tab.tab]?.[0]);
  if (firstBindings.some((binding) => binding === undefined)) return false;
  return new Set(firstBindings).size === firstBindings.length;
}

function startOutcome(tab: TabEvidence): StartOutcome {
  if (!tab.maybeBoard) return "unobserved";
  return tab.maybeBoard.startLeaseCommands === 0 ? "never_reached_board" : "board_refused";
}
