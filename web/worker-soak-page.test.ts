import { expect, test } from "bun:test";
import { createWorkerAcceptanceAuthorization } from "./worker-acceptance-authorization";
import { createWorkerSoakPageOperations } from "./worker-soak-page";

const ledger = { schema: "worker-soak-ledger-v1", next_ordinal: 2, total_charged_ms: 615550, pending: false, last_completed_ordinal: 1 } as const;
const binding = "B".repeat(43);

function soakOperations(overrides: Partial<Parameters<typeof createWorkerSoakPageOperations>[0]> = {}) {
  const calls: string[] = [];
  const operations = {
    enabled: () => true, released: () => true, invalidateAuthorization: () => calls.push("invalidate"),
    controller: () => ({ prepareWorkerLeaseAuthorizationContext: async () => { calls.push("possess"); return { controlSessionBindingSha256: binding }; }, soakAllowanceReview: async () => { calls.push("ledger"); return ledger; } }) as never,
    close: async () => calls.push("close"), flush: async () => calls.push("flush"), state: () => ({ status: "closed" }),
    local: async (path: string) => { calls.push(path); return path === "/completion-context" ? { nonce: "n" } : { result: "passed", ordinal: 1, cumulative_charged_ms: 615550, cleanup_confirmed: true }; },
    ...overrides,
  };
  return { calls, operations: createWorkerSoakPageOperations(operations) };
}

test("soak completion reviews the soak ledger before closing and then submits the judgement", async () => {
  // Arrange
  const { calls, operations } = soakOperations();
  // Act
  const receipt = await operations.submitSoakCompletion();
  // Assert
  expect(receipt.result).toBe("passed");
  expect(calls).toEqual(["invalidate", "/completion-context", "possess", "ledger", "close", "flush", "/completion-review"]);
});

test("soak completion is refused outside soak mode or before restoration", async () => {
  // Arrange
  const outside = soakOperations({ enabled: () => false }).operations, unreleased = soakOperations({ released: () => false }).operations;
  // Act / Assert
  await expect(outside.submitSoakCompletion()).rejects.toThrow("soak_completion_admission");
  await expect(unreleased.submitSoakCompletion()).rejects.toThrow("soak_completion_admission");
});

test("a malformed completion receipt is rejected", async () => {
  // Arrange
  const { operations } = soakOperations({ local: async (path: string) => path === "/completion-context" ? { nonce: "n" } : { result: "passed", ordinal: 0 } });
  // Act / Assert
  await expect(operations.submitSoakCompletion()).rejects.toThrow("soak_completion_receipt");
});

test("the soak budget review mode reports the device soak ledger under the signing binding", async () => {
  // Arrange
  const posted: unknown[] = [];
  const authorization = createWorkerAcceptanceAuthorization({
    requireStartScope() {}, maybeReviewedContext: () => undefined, reviewedContext() {}, showBinding() {}, state: () => ({}),
    prove: async () => ({ controlSessionBindingSha256: binding }) as never,
    attemptReview: async () => { throw new Error("qualification ledger must not be read"); },
    soakReview: async () => ledger as never, budgetReview: async () => { throw new Error("legacy budget must not be read"); },
    local: async (path: string, body: object) => { posted.push(body); return path === "/budget-review-context" ? { nonce: "n", mode: "soak" } : { budget_review_saved: true }; },
  });
  // Act
  const report = await authorization.submitBudgetReview();
  // Assert
  expect(report).toEqual(ledger);
  expect(posted[1]).toMatchObject({ report: ledger, controlSessionBindingSha256: binding });
});
