import { expect, test } from "bun:test";
import {
  CONTEXT_HOLD_MILLISECONDS,
  GATE_NEGATIVE_CASES,
  caseTabs,
  caseVerdict,
  decideGrant,
  emptyInterceptionState,
  parseGateNegativeCases,
  type PausedGrant,
  type TabEvidence,
  type GateCase,
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
    renewGrants: 0,
    maybeConsent: { workers: ["Bitaxe Gamma 601"], duration: "40.0 seconds estimated" },
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

/** A tab whose grants all passed, mined to the Work Requirement and redeemed its Gate Pass. */
function journeyTab(tab = "a"): TabEvidence {
  return {
    tab,
    maybeInterception: { action: "passed", heldMilliseconds: 0 },
    authorityStates: ["issued", "active", "satisfied", "pass_issued"],
    verifiedProgress: "35184372088832",
    progressEvents: 6,
    resyncRequired: false,
    recorderErrors: [],
    cancelAccepted: false,
    gatePassRequests: 2,
    renewGrants: 3,
    maybeRedeemStatus: 200,
    maybeSpentPass: { refresh: "identical", replayStatus: 401, replayError: "invalid_redemption" },
    maybeConsent: { workers: ["Bitaxe Ultra 205"], duration: "80.0 seconds estimated" },
    maybeBoard: {
      startLeaseCommands: 1,
      leasesStarted: 1,
      startRejections: [],
      minerStarts: 1,
      restorationReason: "challenge_satisfied",
      portClosed: true,
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
  const names = (caseName: GateCase) => caseTabs(caseName).map((tab) => tab.name);
  expect([names("withheld"), names("expired_context"), names("handed_over")]).toEqual([["a"], ["a"], ["a", "b"]]);
});

test("runs a handover's second tab in its own browser profile, since one profile admits one Worker Serial session", () => {
  expect(caseTabs("handed_over")).toEqual([
    { name: "a", ownProfile: false },
    { name: "b", ownProfile: true },
  ]);
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

test("parses the journey case, but leaves it out of the default negatives so a bare run never mines", () => {
  // Act
  const parsed = parseGateNegativeCases("journey");

  // Assert
  expect(parsed).toEqual(["journey"]);
  expect(GATE_NEGATIVE_CASES).not.toContain("journey");
});

test("runs a journey in one tab", () => {
  expect(caseTabs("journey")).toEqual([{ name: "a", ownProfile: false }]);
});

test("passes a journey's first Start grant through and marks its tab handled", () => {
  // Arrange
  const grant = paused("a");

  // Act
  const { state, decisions } = decideGrant("journey", emptyInterceptionState(), grant);

  // Assert
  expect(decisions).toEqual([{ type: "pass", key: "a-start" }]);
  expect(state.handledTabs).toEqual(["a"]);
});

test("passes a journey that mined to the requirement, renewed and redeemed with no audit violation", () => {
  // Act
  const verdict = caseVerdict("journey", [journeyTab()], cleanAudit);

  // Assert
  expect(verdict).toEqual({ passed: true, failures: [], startByTab: { a: "lease_started" } });
});

test("fails a journey whose Start grant was not passed through", () => {
  // Arrange
  const tabs = [{ ...journeyTab(), maybeInterception: { action: "withheld" as const, heldMilliseconds: 0 } }];

  // Act
  const verdict = caseVerdict("journey", tabs, cleanAudit);

  // Assert
  expect(verdict.failures).toEqual(["tab a: the Start grant was not passed through"]);
});

test("fails a journey that never reached pass_issued", () => {
  // Arrange
  const tabs = [{ ...journeyTab(), authorityStates: ["issued", "active", "satisfied"] }];

  // Act
  const verdict = caseVerdict("journey", tabs, cleanAudit);

  // Assert
  expect(verdict.failures).toEqual(["tab a: the Authority did not reach pass_issued"]);
});

test("fails a journey in which no Renew grant was seen, since the audit searched none", () => {
  // Arrange
  const tabs = [{ ...journeyTab(), renewGrants: 0 }];

  // Act
  const verdict = caseVerdict("journey", tabs, cleanAudit);

  // Assert
  expect(verdict.failures).toEqual(["tab a: no Renew grant was seen, so none was searched"]);
});

test("fails a journey whose redemption was refused", () => {
  // Arrange
  const tabs = [{ ...journeyTab(), maybeRedeemStatus: 401 }];

  // Act
  const verdict = caseVerdict("journey", tabs, cleanAudit);

  // Assert
  expect(verdict.failures).toEqual(["tab a: the redemption was answered 401"]);
});

test("passes a journey whose spent pass lookup was refused rather than answered with the same pass", () => {
  // Arrange
  const tabs = [{ ...journeyTab(), maybeSpentPass: { refresh: "refused" as const, replayStatus: 401, replayError: "invalid_redemption" } }];

  // Act
  const verdict = caseVerdict("journey", tabs, cleanAudit);

  // Assert
  expect(verdict.failures).toEqual([]);
});

test("fails a journey whose spent pass was never retried", () => {
  // Arrange
  const { maybeSpentPass: _, ...tab } = journeyTab();

  // Act
  const verdict = caseVerdict("journey", [tab], cleanAudit);

  // Assert
  expect(verdict.failures).toEqual(["tab a: the spent Gate Pass wasn't retried"]);
});

test("fails a journey whose second lookup returned a different Gate Pass", () => {
  // Arrange
  const tabs = [{ ...journeyTab(), maybeSpentPass: { refresh: "different" as const, replayStatus: 401, replayError: "invalid_redemption" } }];

  // Act
  const verdict = caseVerdict("journey", tabs, cleanAudit);

  // Assert
  expect(verdict.failures).toEqual(["tab a: a second lookup returned a different Gate Pass"]);
});

test("fails a journey whose spent pass redeemed again", () => {
  // Arrange
  const tabs = [{ ...journeyTab(), maybeSpentPass: { refresh: "identical" as const, replayStatus: 200, replayError: "" } }];

  // Act
  const verdict = caseVerdict("journey", tabs, cleanAudit);

  // Assert
  expect(verdict.failures).toEqual(["tab a: the spent Gate Pass was answered 200"]);
});

test("fails a journey whose spent pass was refused for another reason", () => {
  // Arrange
  const tabs = [{ ...journeyTab(), maybeSpentPass: { refresh: "identical" as const, replayStatus: 502, replayError: "authority_unavailable" } }];

  // Act
  const verdict = caseVerdict("journey", tabs, cleanAudit);

  // Assert
  expect(verdict.failures).toEqual(["tab a: the spent Gate Pass was answered 502 authority_unavailable"]);
});

test("fails a journey with no redemption response", () => {
  // Arrange
  const { maybeRedeemStatus: _, ...tab } = journeyTab();

  // Act
  const verdict = caseVerdict("journey", [tab], cleanAudit);

  // Assert
  expect(verdict.failures).toEqual(["tab a: no redemption response was seen"]);
});

test("fails a journey the page cancelled", () => {
  // Arrange
  const tabs = [{ ...journeyTab(), cancelAccepted: true }];

  // Act
  const verdict = caseVerdict("journey", tabs, cleanAudit);

  // Assert
  expect(verdict.failures).toEqual(["tab a: the Authority accepted a Cancel"]);
});

test("fails a journey whose board didn't restore for the satisfied challenge", () => {
  // Arrange
  const tab = journeyTab();
  const tabs = [{ ...tab, maybeBoard: { ...tab.maybeBoard!, restorationReason: "cancelled" } }];

  // Act
  const verdict = caseVerdict("journey", tabs, cleanAudit);

  // Assert
  expect(verdict.failures).toEqual(["tab a: the board did not restore for the satisfied challenge"]);
});

test("fails any case whose consent named more than the connected board", () => {
  // Arrange
  const tabs = [{ ...endedTab("a", "withheld"), maybeConsent: { workers: ["Bitaxe Gamma 601", "Bitaxe Ultra 205"], duration: "26.7 seconds estimated" } }];

  // Act
  const verdict = caseVerdict("withheld", tabs, cleanAudit);

  // Assert
  expect(verdict.failures).toEqual(["tab a: the consent named 2 Workers, not only the connected board"]);
});

test("fails any case whose consent wasn't read", () => {
  // Arrange
  const { maybeConsent: _, ...tab } = journeyTab();

  // Act
  const verdict = caseVerdict("journey", [tab], cleanAudit);

  // Assert
  expect(verdict.failures).toEqual(["tab a: the consent's Workers were not read"]);
});
