import { parseBudgetCampaignId, parseWorkerBudgetReview, type WorkerBudgetReview } from "./worker-budget-review";
import { parseQualificationCoolingResult } from "./worker-qualification-cooling";
import { exactSerialRecord, serialFailure } from "./worker-serial";

type CoolingReviewOperations = {
  local(path: string, body: object): Promise<unknown>;
  possess(): Promise<unknown>;
  budget(campaignId: string): Promise<WorkerBudgetReview>;
  proveFan(): Promise<unknown>;
  restoreFan(): Promise<unknown>;
  state(): unknown;
};
/** Executes the no-mining review; private context and proof bindings never escape. */
export async function submitWorkerCoolingReview(operations: CoolingReviewOperations) {
  const context = exactSerialRecord(await operations.local("/cooling-review-context", {}), ["campaignId", "nonce"]);
  if (typeof context.campaignId !== "string" || typeof context.nonce !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(context.nonce)) throw serialFailure("fields");
  const campaignId = parseBudgetCampaignId(context.campaignId);
  await operations.possess();
  const before = parseWorkerBudgetReview(await operations.budget(campaignId));
  if (!before.campaign_match || before.pending) throw serialFailure("probe_admission");
  const proof = parseQualificationCoolingResult("prove_fan", await operations.proveFan());
  const restoration = parseQualificationCoolingResult("restore_baseline", await operations.restoreFan());
  await operations.possess();
  const after = parseWorkerBudgetReview(await operations.budget(campaignId));
  if (JSON.stringify(before) !== JSON.stringify(after)) throw serialFailure("fields");
  const receipt = exactSerialRecord(await operations.local("/cooling-review", {
    nonce: context.nonce, proof, restoration, budget_before: before, budget_after: after, state: operations.state(),
  }), ["cooling_review_saved", "review_file"]);
  if (receipt.cooling_review_saved !== true || receipt.review_file !== `cooling-review-${context.nonce}.json`) throw serialFailure("fields");
  return { cooling_review_saved: true as const, review_file: receipt.review_file, budget_unchanged: true as const };
}
