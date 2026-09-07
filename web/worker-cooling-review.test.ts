import { expect, test } from "bun:test";
import { submitWorkerCoolingReview } from "./worker-cooling-review";
import type { WorkerBudgetReview } from "./worker-budget-review";

function fixture() {
  const calls: string[] = [];
  const posted: object[] = [];
  const budget: { -readonly [Key in keyof WorkerBudgetReview]: WorkerBudgetReview[Key] } = { schema: "worker-budget-review-v1", campaign_match: true, reserved_mask: 3, completed_mask: 3, charged_ms: 210000, pending: false };
  const operations = {
    async local(path: string, body: object): Promise<unknown> {
      calls.push(path);
      if (path === "/cooling-review-context") return { campaignId: "AAAAAAAAAAAAAAAAAAAAAA", nonce: "fixture_nonce" };
      posted.push(body);
      return { cooling_review_saved: true, review_file: "cooling-review-fixture_nonce.json" };
    },
    async possess() { calls.push("possess"); return { controlSessionBindingSha256: "private-binding" }; },
    async attemptBudget() { return { schema: "worker-qualification-ledger-v1" as const, next_ordinal: 1, total_charged_ms: 0, pending: false, last_completed_ordinal: 0 }; },
    async budget(_campaignId: string) { calls.push("budget"); return { ...budget }; },
    async proveFan() { calls.push("prove"); return { schema: "worker-cooling-proof-v1", fan_duty_percent: 100, fan_rpm: 4200, post_command_fan_proven: true, asic_effects: false, budget_reserved: false }; },
    async restoreFan() { calls.push("restore"); return { schema: "worker-cooling-baseline-v1", fan_duty_percent: 30, cooling_proven: true, asic_effects: false, budget_reserved: false }; },
    state() { return { connected: true, running: false, deviceRestorationConfirmed: true }; },
  };
  return { operations, calls, posted, budget };
}
test("cooling review orders possession, budgets and fan restoration without leaking identity or binding", async () => {
  // Arrange
  const h = fixture();
  // Act
  const result = await submitWorkerCoolingReview(h.operations);
  // Assert
  expect(h.calls).toEqual(["/cooling-review-context", "possess", "budget", "prove", "restore", "possess", "budget", "/cooling-review"]);
  expect(result).toEqual({ cooling_review_saved: true, review_file: "cooling-review-fixture_nonce.json", budget_unchanged: true });
  const exposed = JSON.stringify({ posted: h.posted, result });
  expect(exposed).not.toContain("AAAAAAAAAAAAAAAAAAAAAA");
  expect(exposed).not.toContain("private-binding");
});
test("mismatched campaign blocks the fan effect", async () => {
  const h = fixture();
  h.budget.campaign_match = false;
  await expect(submitWorkerCoolingReview(h.operations)).rejects.toThrow();
  expect(h.calls).not.toContain("prove");
});
test("changed budget after fan restoration cannot produce a receipt", async () => {
  const h = fixture();
  h.operations.restoreFan = async () => { h.budget.reserved_mask = 7; h.budget.completed_mask = 7; h.budget.charged_ms = 240000; return { schema: "worker-cooling-baseline-v1", fan_duty_percent: 30, cooling_proven: true, asic_effects: false, budget_reserved: false }; };
  await expect(submitWorkerCoolingReview(h.operations)).rejects.toThrow();
  expect(h.posted).toHaveLength(0);
});

test("iterative cooling uses the separate ledger and stores no campaign identifier", async () => {
  // Arrange
  const h = fixture();
  h.operations.local = async (path, body) => {
    h.calls.push(path);
    if (path === "/cooling-review-context") return { mode: "iterative", nonce: "fixture_nonce" };
    h.posted.push(body);
    return { cooling_review_saved: true, review_file: "cooling.json" };
  };
  // Act
  const receipt = await submitWorkerCoolingReview(h.operations);
  // Assert
  expect(receipt.review_file).toBe("cooling.json");
  expect(h.calls).not.toContain("budget");
  expect(JSON.stringify(h.posted)).toContain("worker-qualification-ledger-v1");
  expect(JSON.stringify(h.posted)).not.toContain("campaignId");
});
