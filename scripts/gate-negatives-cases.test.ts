import { expect, test } from "bun:test";
import {
  CONTEXT_HOLD_MILLISECONDS,
  caseTabs,
  caseVerdict,
  decideGrant,
  emptyInterceptionState,
  parseGateNegativeCases,
  type PausedGrant,
  type TabEvidence,
} from "./gate-negatives-cases";

function paused(tab: string, operation: PausedGrant["operation"] = "start", pausedAtMilliseconds = 1_000): PausedGrant {
  return { key: `${tab}-${operation}`, tab, operation, pausedAtMilliseconds };
}

function endedTab(tab: string, action: NonNullable<TabEvidence["maybeInterception"]>["action"]): TabEvidence {
  return {
    tab,
    maybeInterception: { action, heldMilliseconds: action === "held" ? 65_000 : 0 },
    authorityStates: ["issued", "active", "cancelled"],
    verifiedProgress: "0",
    progressEvents: 1,
    resyncRequired: false,
    recorderErrors: [],
    cancelAccepted: true,
    gatePassRequests: 0,
    maybeBoard: {
      startLeaseCommands: action === "held" ? 1 : 0,
      leasesStarted: 0,
      startRejections: action === "held" ? ["admission_required"] : [],
      minerStarts: 0,
      // A Start the board refuses ends the serial session, so the page drops the port instead of cancelling.
      restorationReason: action === "held" ? undefined : "cancelled",
      portClosed: action === "held",
    },
  };
}

const cleanAudit = { violations: [], startBindingsByTab: { a: ["A".repeat(43)], b: ["B".repeat(43)] } };

test("parses a comma-separated case list", () => {
  expect(parseGateNegativeCases("withheld,handed_over")).toEqual(["withheld", "handed_over"]);
});

test("refuses an unknown case", () => {
  expect(() => parseGateNegativeCases("withheld,replayed")).toThrow('unknown case "replayed"');
});

test("hands over between two tabs and runs the others in one", () => {
  expect([caseTabs("withheld"), caseTabs("expired_context"), caseTabs("handed_over")]).toEqual([["a"], ["a"], ["a", "b"]]);
});

test("passes a renewal through unchanged", () => {
  // Arrange
  const grant = paused("a", "renew");

  // Act
  const { decisions } = decideGrant("withheld", emptyInterceptionState(), grant);

  // Assert
  expect(decisions).toEqual([{ type: "pass", key: grant.key }]);
});

test("withholds a Start grant", () => {
  // Arrange
  const grant = paused("a");

  // Act
  const { decisions } = decideGrant("withheld", emptyInterceptionState(), grant);

  // Assert
  expect(decisions).toEqual([{ type: "withhold", key: grant.key }]);
});

test("holds a Start grant past the board's unused-context window", () => {
  // Arrange
  const grant = paused("a", "start", 5_000);

  // Act
  const { decisions } = decideGrant("expired_context", emptyInterceptionState(), grant);

  // Assert
  expect(decisions).toEqual([
    { type: "deliver", key: grant.key, fromKey: grant.key, notBeforeMilliseconds: 5_000 + CONTEXT_HOLD_MILLISECONDS },
  ]);
});

test("keeps the hold above 60 s", () => {
  expect(CONTEXT_HOLD_MILLISECONDS).toBeGreaterThan(60_000);
});

test("keeps the first tab's Start grant until the other tab's arrives", () => {
  // Arrange
  const grant = paused("a");

  // Act
  const { decisions } = decideGrant("handed_over", emptyInterceptionState(), grant);

  // Assert
  expect(decisions).toEqual([]);
});

test("swaps the two tabs' Start grants once both are held", () => {
  // Arrange
  const first = paused("a", "start", 1_000);
  const second = paused("b", "start", 4_000);
  const { state } = decideGrant("handed_over", emptyInterceptionState(), first);

  // Act
  const { decisions } = decideGrant("handed_over", state, second);

  // Assert
  expect(decisions).toEqual([
    { type: "deliver", key: second.key, fromKey: first.key, notBeforeMilliseconds: 4_000 },
    { type: "deliver", key: first.key, fromKey: second.key, notBeforeMilliseconds: 4_000 },
  ]);
});

test("leaves a tab's later Start to the page once its grant was handled", () => {
  // Arrange
  const { state } = decideGrant("withheld", emptyInterceptionState(), paused("a"));
  const retry = { ...paused("a"), key: "a-start-2" };

  // Act
  const { decisions } = decideGrant("withheld", state, retry);

  // Assert
  expect(decisions).toEqual([{ type: "pass", key: retry.key }]);
});

test("passes a withheld grant that ended before mining with no Gate Pass", () => {
  // Arrange
  const tabs = [endedTab("a", "withheld")];

  // Act
  const verdict = caseVerdict("withheld", tabs, cleanAudit);

  // Assert
  expect(verdict).toEqual({ passed: true, failures: [], startByTab: { a: "never_reached_board" } });
});

test("fails a case in which the board started mining", () => {
  // Arrange
  const tab = endedTab("a", "withheld");
  const tabs = [{ ...tab, maybeBoard: { ...tab.maybeBoard!, leasesStarted: 1, minerStarts: 1 } }];

  // Act
  const verdict = caseVerdict("withheld", tabs, cleanAudit);

  // Assert
  expect(verdict.failures).toEqual(["tab a: the board started a lease", "tab a: the miner was started"]);
});

test("fails a case that advanced Verified Progress", () => {
  // Arrange
  const tabs = [{ ...endedTab("a", "withheld"), verifiedProgress: "1024" }];

  // Act
  const verdict = caseVerdict("withheld", tabs, cleanAudit);

  // Assert
  expect(verdict.failures).toEqual(["tab a: the Authority reported Verified Progress"]);
});

test("fails a case in which the audit saw no Start binding from a tab", () => {
  // Arrange
  const audit = { violations: [], startBindingsByTab: {} };

  // Act
  const verdict = caseVerdict("withheld", [endedTab("a", "withheld")], audit);

  // Assert
  expect(verdict.failures).toEqual(["tab a: the audit saw no Start carrying a control-session binding"]);
});

test("fails a case whose event stream never reported Verified Progress", () => {
  // Arrange
  const tabs = [{ ...endedTab("a", "withheld"), progressEvents: 0 }];

  // Act
  const verdict = caseVerdict("withheld", tabs, cleanAudit);

  // Assert
  expect(verdict.failures).toEqual(["tab a: no verified_progress event arrived, so progress is unknown"]);
});

test("fails a case whose event stream skipped updates", () => {
  // Arrange
  const tabs = [{ ...endedTab("a", "withheld"), resyncRequired: true }];

  // Act
  const verdict = caseVerdict("withheld", tabs, cleanAudit);

  // Assert
  expect(verdict.failures).toEqual(["tab a: the event stream skipped updates (resync_required)"]);
});

test("fails a case whose recorder failed", () => {
  // Arrange
  const tabs = [{ ...endedTab("a", "withheld"), recorderErrors: ["the Authority's verified_progress event was malformed"] }];

  // Act
  const verdict = caseVerdict("withheld", tabs, cleanAudit);

  // Assert
  expect(verdict.failures).toEqual(["tab a: the recorder failed: the Authority's verified_progress event was malformed"]);
});

test("fails a case the Authority didn't end", () => {
  // Arrange
  const tabs = [{ ...endedTab("a", "withheld"), authorityStates: ["issued", "active"] }];

  // Act
  const verdict = caseVerdict("withheld", tabs, cleanAudit);

  // Assert
  expect(verdict.failures).toEqual(["tab a: the Authority did not end the attempt as cancelled"]);
});

test("fails a case that issued a Gate Pass", () => {
  // Arrange
  const tabs = [{ ...endedTab("a", "withheld"), authorityStates: ["active", "pass_issued", "cancelled"], gatePassRequests: 1 }];

  // Act
  const verdict = caseVerdict("withheld", tabs, cleanAudit);

  // Assert
  expect(verdict.failures).toEqual([
    "tab a: the Authority reached pass_issued",
    "tab a: the page asked for or redeemed a Gate Pass",
  ]);
});

test("fails a case the page didn't cancel", () => {
  // Arrange
  const tabs = [{ ...endedTab("a", "withheld"), cancelAccepted: false }];

  // Act
  const verdict = caseVerdict("withheld", tabs, cleanAudit);

  // Assert
  expect(verdict.failures).toEqual(["tab a: the Authority did not accept the page's Cancel"]);
});

test("fails a case whose interception never happened", () => {
  // Arrange
  const { maybeInterception: _unused, ...tab } = endedTab("a", "withheld");

  // Act
  const verdict = caseVerdict("withheld", [tab], cleanAudit);

  // Assert
  expect(verdict.failures).toEqual(["tab a: the Start grant was not withheld"]);
});

test("fails a withheld grant that reached the board anyway", () => {
  // Arrange
  const tab = endedTab("a", "withheld");
  const tabs = [{ ...tab, maybeBoard: { ...tab.maybeBoard!, startLeaseCommands: 1 } }];

  // Act
  const verdict = caseVerdict("withheld", tabs, cleanAudit);

  // Assert
  expect(verdict.failures).toEqual(["tab a: a withheld grant reached the board"]);
});

test("passes an aged context the board refused", () => {
  // Arrange
  const tabs = [endedTab("a", "held")];

  // Act
  const verdict = caseVerdict("expired_context", tabs, cleanAudit);

  // Assert
  expect(verdict).toEqual({ passed: true, failures: [], startByTab: { a: "board_refused" } });
});

test("fails a case whose board session never ended", () => {
  // Arrange
  const tab = endedTab("a", "held");
  const tabs = [{ ...tab, maybeBoard: { ...tab.maybeBoard!, portClosed: false } }];

  // Act
  const verdict = caseVerdict("expired_context", tabs, cleanAudit);

  // Assert
  expect(verdict.failures).toEqual(["tab a: the board neither confirmed restoration nor lost its port"]);
});

test("fails a held grant released inside the context window", () => {
  // Arrange
  const tabs = [{ ...endedTab("a", "held"), maybeInterception: { action: "held" as const, heldMilliseconds: 59_000 } }];

  // Act
  const verdict = caseVerdict("expired_context", tabs, cleanAudit);

  // Assert
  expect(verdict.failures).toEqual(["tab a: the grant was held for less than the board's 60 s context"]);
});

test("fails an aged context the board refused for another reason", () => {
  // Arrange
  const tab = endedTab("a", "held");
  const tabs = [{ ...tab, maybeBoard: { ...tab.maybeBoard!, startRejections: ["authentication_failed"] } }];

  // Act
  const verdict = caseVerdict("expired_context", tabs, cleanAudit);

  // Assert
  expect(verdict.failures).toEqual(["tab a: the board did not refuse the Start for its expired context"]);
});

test("passes handed-over grants refused by each page", () => {
  // Arrange
  const tabs = [endedTab("a", "handed_over"), endedTab("b", "handed_over")];

  // Act
  const verdict = caseVerdict("handed_over", tabs, cleanAudit);

  // Assert
  expect(verdict).toEqual({ passed: true, failures: [], startByTab: { a: "never_reached_board", b: "never_reached_board" } });
});

test("accepts a handed-over grant the board refused as unauthenticated", () => {
  // Arrange
  const tab = endedTab("b", "handed_over");
  const tabs = [endedTab("a", "handed_over"), {
    ...tab,
    maybeBoard: { ...tab.maybeBoard!, startLeaseCommands: 1, startRejections: ["authentication_failed"] },
  }];

  // Act
  const verdict = caseVerdict("handed_over", tabs, cleanAudit);

  // Assert
  expect(verdict.startByTab).toEqual({ a: "never_reached_board", b: "board_refused" });
});

test("fails a handover between tabs that share a control-session binding", () => {
  // Arrange
  const tabs = [endedTab("a", "handed_over"), endedTab("b", "handed_over")];
  const audit = { violations: [], startBindingsByTab: { a: ["A".repeat(43)], b: ["A".repeat(43)] } };

  // Act
  const verdict = caseVerdict("handed_over", tabs, audit);

  // Assert
  expect(verdict.failures).toEqual(["the two tabs' control-session bindings are not distinct"]);
});

test("fails a case whose requests broke the audit", () => {
  // Arrange
  const audit = { ...cleanAudit, violations: ["a board value reached the Authority on POST /account-creation/challenge"] };

  // Act
  const verdict = caseVerdict("withheld", [endedTab("a", "withheld")], audit);

  // Assert
  expect(verdict.failures).toEqual(["a board value reached the Authority on POST /account-creation/challenge"]);
});

test("judges a real board by the Authority's view when the harness can't read it", () => {
  // Arrange
  const { maybeBoard: _unused, ...tab } = endedTab("a", "withheld");

  // Act
  const verdict = caseVerdict("withheld", [tab], cleanAudit);

  // Assert
  expect(verdict).toEqual({ passed: true, failures: [], startByTab: { a: "unobserved" } });
});
