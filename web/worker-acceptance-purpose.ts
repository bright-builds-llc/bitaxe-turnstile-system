import type { WorkerLeaseGrant } from "./worker-controller";
/** Soak leases use their own window kind, so qualification-window rules never apply to them. */
export const SOAK_ACCEPTANCE_WINDOW = 3;
export function acceptancePurposeWindow(grant: WorkerLeaseGrant): number {
  if (grant.soakAllowance) return SOAK_ACCEPTANCE_WINDOW;
  if (grant.acceptanceCampaign) return grant.acceptanceCampaign.window;
  return ({ diagnostic: -1, normal: 0, foreground_loss: 1, heartbeat_loss: 2 } as const)[grant.qualificationAttempt?.purpose ?? "diagnostic"];
}
export function acceptanceMaximumActiveMilliseconds(grant: WorkerLeaseGrant): number {
  const limit = grant.soakAllowance?.maximumActiveMilliseconds ?? grant.acceptanceCampaign?.maximumActiveMilliseconds ?? grant.qualificationAttempt?.maximumActiveMilliseconds;
  if (limit === undefined) throw new Error("qualification_bound_missing");
  return limit;
}
