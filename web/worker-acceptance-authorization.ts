import type { WorkerLeaseAuthorizationContext } from "./worker-lease-authorization";
import type { WorkerQualificationLedger } from "./worker-qualification-attempt";
import type { WorkerBudgetReview } from "./worker-budget-review";
import type { WorkerSoakLedger } from "./worker-soak-allowance";

/** Existing review-to-signing flow. Cached possession stays private and is consumed once by issuance. */
export function createWorkerAcceptanceAuthorization(operations: {
  requireStartScope(): void;
  maybeReviewedContext(): WorkerLeaseAuthorizationContext | undefined;
  reviewedContext(value: WorkerLeaseAuthorizationContext | undefined): void;
  prove(): Promise<WorkerLeaseAuthorizationContext>;
  showBinding(binding: string): void;
  attemptReview(): Promise<WorkerQualificationLedger>;
  soakReview(): Promise<WorkerSoakLedger>;
  budgetReview(campaignId: string): Promise<WorkerBudgetReview>;
  state(): unknown;
  local(path: string, body: object): Promise<unknown>;
}) {
  return {
    async prepareStartAuthorization() {
      operations.requireStartScope();
      const context = operations.maybeReviewedContext() ?? await operations.prove();
      operations.reviewedContext(undefined); operations.showBinding(context.controlSessionBindingSha256);
      await operations.local("/authorization-context", context);
      return context;
    },
    async submitBudgetReview() {
      operations.reviewedContext(undefined);
      const input = await operations.local("/budget-review-context", {});
      if (!input || typeof input !== "object" || Object.keys(input).length !== 2 || !("nonce" in input) || typeof input.nonce !== "string") throw new Error("budget_review_context");
      const mode = "mode" in input && (input.mode === "iterative" || input.mode === "soak") ? input.mode : undefined;
      if (mode === undefined && (!("campaignId" in input) || typeof input.campaignId !== "string")) throw new Error("budget_review_context");
      const context = await operations.prove();
      // A soak signs its ordinal from the device soak ledger read under the same possession binding.
      const report = mode === "soak" ? await operations.soakReview() : mode === "iterative" ? await operations.attemptReview() : await operations.budgetReview((input as unknown as { campaignId: string }).campaignId);
      const receipt = await operations.local("/budget-review", { nonce: input.nonce, report, controlSessionBindingSha256: context.controlSessionBindingSha256, state: operations.state() });
      if (!receipt || typeof receipt !== "object" || !("budget_review_saved" in receipt) || receipt.budget_review_saved !== true) throw new Error("budget_review_receipt");
      operations.reviewedContext(context);
      return report;
    },
  };
}
