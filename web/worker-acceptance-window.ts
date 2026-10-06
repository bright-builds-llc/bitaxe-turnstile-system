import { parseWorkerLeaseGrant, parseWorkerLeaseRenewal, type WorkerLeaseGrant, type WorkerLeaseRenewal } from "./worker-controller";
import { maximumWindowRenewals } from "./worker-serial-acceptance-actions";
import type { WorkerSerialAcceptanceConfiguration } from "./worker-serial-acceptance-config";
import { isWorkerV2Stratum } from "./worker-v2-stratum";

// Declared as a function so host compatibility harnesses can extract and execute it with the parser.
function exactSixtyTwenty(value: { durationMilliseconds: number; renewAfterMilliseconds: number }): boolean {
  return value.durationMilliseconds === 60000 && value.renewAfterMilliseconds === 20000;
}

/** Parse one signed window completely before any page state changes; the active mode decides which windows load. */
export function parseAcceptanceWindow(
  input: { grant: unknown; renewals: unknown },
  maybeConfiguration: Pick<WorkerSerialAcceptanceConfiguration, "stratumV2Qualification" | "soakQualification"> | undefined,
  requireCadenceWindow: (grant: WorkerLeaseGrant) => void,
): { grant: WorkerLeaseGrant; renewals: WorkerLeaseRenewal[] } {
  const grant = parseWorkerLeaseGrant(input.grant);
  requireCadenceWindow(grant);
  if (maybeConfiguration?.stratumV2Qualification && (!isWorkerV2Stratum(grant.stratum) || grant.qualificationAttempt?.purpose !== "normal" || grant.qualificationAttempt.maximumActiveMilliseconds !== 180000 || !exactSixtyTwenty(grant))) throw new Error("v2_share_window");
  if (!grant.acceptanceCampaign && !grant.qualificationAttempt && !grant.soakAllowance) throw new Error("acceptance_campaign_required");
  if (Boolean(grant.soakAllowance) !== Boolean(maybeConfiguration?.soakQualification)) throw new Error("soak_mode_window");
  if (!Array.isArray(input.renewals) || input.renewals.length > maximumWindowRenewals(grant)) throw new Error("renewal_bound");
  const renewals = input.renewals.map(parseWorkerLeaseRenewal);
  if (grant.soakAllowance && !renewals.every(exactSixtyTwenty)) throw new Error("soak_renewal_window");
  if (maybeConfiguration?.stratumV2Qualification && !renewals.every(exactSixtyTwenty)) throw new Error("v2_renewal_window");
  if (renewals.some((value) => value.leaseId !== grant.leaseId)) throw new Error("renewal_lease_mismatch");
  return { grant, renewals };
}
