import type { WorkerContinuityScope } from "./worker-continuity-store";

/**
 * The local supervisor's `/activate` answer. It may return the same scope on every connect, which is how a
 * restoration scenario keeps one challenge across reconnects and a reboot.
 */
export function parseWorkerAcceptanceActivation(value: unknown): WorkerContinuityScope {
  if (!value || typeof value !== "object" || Object.keys(value).length !== 2 || !("challengeId" in value) || typeof value.challengeId !== "string" ||
    !("retentionExpiryUnixSeconds" in value) || typeof value.retentionExpiryUnixSeconds !== "number" || !Number.isSafeInteger(value.retentionExpiryUnixSeconds))
    throw new Error("activation_invalid");
  return { challengeId: value.challengeId, retentionExpiryUnixSeconds: value.retentionExpiryUnixSeconds };
}
