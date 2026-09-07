#!/usr/bin/env bun
/** Public RFC 8032 test key only; never reads operational signing inputs. */
import { writeFile } from "node:fs/promises";
import { signWorkerLeaseAuthorization, type WorkLeaseAuthorityTrust } from "../web/worker-lease-authorization";
import { parseWorkerLeaseGrant } from "../web/worker-controller";
import type { QualificationAttemptPurpose } from "../web/worker-qualification-attempt";
import controller from "../conformance/bwg-worker-controller-0.4/fixtures.json";
const seed = Buffer.from("302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex");
const privateKey = await crypto.subtle.importKey("pkcs8", seed, "Ed25519", false, ["sign"]);
const trust: WorkLeaseAuthorityTrust = { profile: "bwg-worker-deployment-trust/0.2", issuer: "fixture-qualification-attempt", audience: "bwg-worker-controller/0.4", role: "work_lease_authority", keys: [{ kid: "rfc8032", kty: "OKP", crv: "Ed25519", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo", alg: "Ed25519", use: "sig", key_ops: ["verify"] }] };
const binding = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const purposes: QualificationAttemptPurpose[] = ["diagnostic", "normal", "foreground_loss", "heartbeat_loss"];
const vectors = [];
for (const [index, purpose] of purposes.entries()) {
  const { authorization: _authorization, ...request } = parseWorkerLeaseGrant({ ...controller.lease, qualificationAttempt: { schema: "worker-qualification-attempt-v1", id: "AAAAAAAAAAAAAAAAAAAAAA", ordinal: index + 1, purpose, maximumActiveMilliseconds: purpose === "normal" ? 180000 : 30000 } });
  const input = { operation: "start" as const, activeChallengeId: request.challengeId, controlSessionBindingSha256: binding, request };
  const authorization = await signWorkerLeaseAuthorization({ input, sequence: String(index + 1), kid: "rfc8032", issuer: trust.issuer, audience: trust.audience, privateKey });
  vectors.push({ purpose, input, grant: { ...request, authorization } });
}
await writeFile("conformance/bwg-worker-controller-0.4/qualification-attempt-vectors.json", JSON.stringify({ classification: "public-rfc8032-conformance-only", trust, vectors }, null, 2) + "\n");
