import { expect, test } from "bun:test";
import { parseBudgetCampaignId, parseWorkerBudgetReview, type WorkerBudgetReview } from "./worker-budget-review";
import { maybeWorkerSerialDiagnostic } from "./worker-serial-diagnostics";
const review: WorkerBudgetReview = { schema: "worker-budget-review-v1", campaign_match: true, reserved_mask: 1, completed_mask: 1, charged_ms: 180000, pending: false };

test("budget review admits closed counters without echoing campaign identity", () => {
  expect(parseWorkerBudgetReview(review)).toEqual(review);
});
test("budget review rejects extra fields and inconsistent counters", () => {
  // Arrange
  const invalid = [{ ...review, campaignId: "private" }, { ...review, pending: true }, { ...review, completed_mask: 2 }, { ...review, reserved_mask: 8 }, { ...review, charged_ms: 240001 }];
  // Act / Assert
  for (const value of invalid) expect(() => parseWorkerBudgetReview(value)).toThrow();
});
test("budget campaign identifier is canonical and exactly sixteen bytes", () => {
  expect(parseBudgetCampaignId("AAAAAAAAAAAAAAAAAAAAAA")).toBe("AAAAAAAAAAAAAAAAAAAAAA");
  for (const value of ["private", "AAAAAAAAAAAAAAAAAAAAAB", "AAAAAAAAAAAAAAAAAAAAAA="]) expect(() => parseBudgetCampaignId(value)).toThrow();
});
test("admission observations reject arbitrary data and overbudget counters", () => {
  // Arrange
  const line = "worker_admission schema=v1 stage=cleanup first_failure=readiness readiness=63 budget_reserved_ms=180000 budget_complete=false redacted=true";
  // Act / Assert
  expect(maybeWorkerSerialDiagnostic(line)).toEqual({ category: "worker_admission", authoritative: false, stage: "cleanup", first_failure: "readiness", readiness: 63, budget_reserved_ms: 180000, budget_complete: "false" });
  for (const invalid of [line.replace("readiness=63", "readiness=64"), line.replace("180000", "240001"), line.replace("stage=cleanup", "stage=private"), `${line} payload=private`]) expect(maybeWorkerSerialDiagnostic(invalid)).toBeUndefined();
});


test("production serial controller reviews the supplied campaign after possession", async () => {
  // Arrange
  const { serialHarness } = await import("./worker-serial.test-support");
  const h = await serialHarness();
  await h.controller.requestPermission();
  try {
    // Act
    const result = await h.controller.acceptanceBudgetReview("AAAAAAAAAAAAAAAAAAAAAA");
    // Assert
    expect(result).toEqual(review);
    expect(h.received.some(value => value.command === "acceptance_budget_review")).toBeTrue();
  } finally {
    await h.controller.close();
  }
});
