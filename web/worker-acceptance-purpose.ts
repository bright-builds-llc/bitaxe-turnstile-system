import type { WorkerLeaseGrant } from "./worker-controller";
export function acceptancePurposeWindow(grant: WorkerLeaseGrant): number {
  if (grant.acceptanceCampaign) return grant.acceptanceCampaign.window;
  return ({ diagnostic: -1, normal: 0, foreground_loss: 1, heartbeat_loss: 2 } as const)[grant.qualificationAttempt?.purpose ?? "diagnostic"];
}
export function acceptanceMaximumActiveMilliseconds(grant: WorkerLeaseGrant): number {
  const limit = grant.acceptanceCampaign?.maximumActiveMilliseconds ?? grant.qualificationAttempt?.maximumActiveMilliseconds;
  if (limit === undefined) throw new Error("qualification_bound_missing");
  return limit;
}
