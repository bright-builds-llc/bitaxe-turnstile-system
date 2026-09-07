import { exactSerialRecord, serialFailure } from "./worker-serial";
import { parseWorkerControlRejection } from "./worker-control-rejection";
import { canonicalJson } from "./headless-values";
import { encodeBase64Url, sha256Base64UrlBytes } from "./crypto-bytes";
import { WORKER_LEASE_AUTHORIZATION_PROFILE, WORKER_LEASE_AUTHORIZATION_TYPE, parseWorkLeaseAuthorityTrust, type WorkLeaseAuthorityTrust } from "./worker-lease-authorization";
import { parseWorkerLeaseGrant } from "./worker-controller";

/** Qualification fixture only: no signer, campaign reservation, or operational pool input. */
export async function rejectedStartGrant(challengeId: string, binding: string, trustInput: WorkLeaseAuthorityTrust) {
  const trust = parseWorkLeaseAuthorityTrust(trustInput);
  const key = trust.keys[0];
  if (!key) throw new Error("rejection_fixture_trust");
  const request = {
    protocolVersion: "bwg-worker-controller/0.4" as const,
    leaseId: "qualification_invalid_signature",
    challengeId,
    durationMilliseconds: 1000,
    renewAfterMilliseconds: 500,
    stratum: { endpoint: "stratum+tcp://127.0.0.1:1/", username: "synthetic", password: "synthetic" },
  };
  const header = { alg: "Ed25519", kid: key.kid, typ: WORKER_LEASE_AUTHORIZATION_TYPE };
  const payload = {
    controlSessionBindingSha256: binding,
    operation: "start",
    requestSha256: await sha256Base64UrlBytes(new TextEncoder().encode(canonicalJson({ profile: WORKER_LEASE_AUTHORIZATION_PROFILE, issuer: trust.issuer, audience: trust.audience, operation: "start", activeChallengeId: challengeId, request }))),
    sequence: "1",
  };
  const segment = (value: unknown) => encodeBase64Url(new TextEncoder().encode(canonicalJson(value)));
  return parseWorkerLeaseGrant({ ...request, authorization: `${segment(header)}.${segment(payload)}.${encodeBase64Url(new Uint8Array(64))}` });
}


/** Requires an exact correlated rejection; any cleanup failure still fails the check. */
export async function runRejectedStart(grant: Awaited<ReturnType<typeof rejectedStartGrant>>, requestId: string, exchange: (request: { requestId: string } & Record<string, unknown>) => Promise<unknown>, close: () => Promise<void>): Promise<{ rejected: true; error: "authentication_failed" }> {
  try {
    const response = exactSerialRecord(await exchange({ protocolVersion: "bwg-worker-controller/0.4", requestId, command: "start_lease", payload: grant }), ["protocolVersion", "requestId", "ok", "error"]);
    if (response.protocolVersion !== "bwg-worker-controller/0.4" || response.ok !== false || parseWorkerControlRejection(response.error) !== "authentication_failed") throw serialFailure("command_rejected");
    return { rejected: true, error: "authentication_failed" };
  } finally { await close(); }
}
