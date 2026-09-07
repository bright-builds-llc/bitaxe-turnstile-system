import { decodeBase64Url, encodeBase64Url } from "./crypto-bytes";
import { exactSerialRecord, serialFailure } from "./worker-serial";

/** Fresh possessed-session observation; it grants no work or budget refund. */
export type WorkerBudgetReview = Readonly<{
  schema: "worker-budget-review-v1";
  campaign_match: boolean;
  reserved_mask: number;
  completed_mask: number;
  charged_ms: number;
  pending: boolean;
}>;
export function parseBudgetCampaignId(value: string): string {
  const bytes = decodeBase64Url(value, 22, "fields");
  if (bytes.length !== 16 || encodeBase64Url(bytes) !== value) throw serialFailure("fields");
  return value;
}
export function parseWorkerBudgetReview(input: unknown): WorkerBudgetReview {
  const value = exactSerialRecord(input, ["schema", "campaign_match", "reserved_mask", "completed_mask", "charged_ms", "pending"]);
  if (value.schema !== "worker-budget-review-v1" || typeof value.campaign_match !== "boolean" || typeof value.pending !== "boolean") throw serialFailure("fields");
  const reserved = value.reserved_mask, completed = value.completed_mask, charged = value.charged_ms;
  if (typeof reserved !== "number" || !Number.isInteger(reserved) || reserved < 0 || reserved > 7 ||
      typeof completed !== "number" || !Number.isInteger(completed) || completed < 0 || completed > 7 ||
      typeof charged !== "number" || !Number.isInteger(charged) || charged < 0 || charged > 240000 ||
      (completed & reserved) !== completed || value.pending !== (reserved !== completed)) throw serialFailure("fields");
  const expectedCharge = (reserved & 1 ? 180000 : 0) + (reserved & 2 ? 30000 : 0) + (reserved & 4 ? 30000 : 0);
  const outstanding = reserved ^ completed;
  if (charged !== expectedCharge || (outstanding & (outstanding - 1)) !== 0) throw serialFailure("fields");
  return Object.freeze({ schema: "worker-budget-review-v1", campaign_match: value.campaign_match, reserved_mask: reserved, completed_mask: completed, charged_ms: charged, pending: value.pending });
}
