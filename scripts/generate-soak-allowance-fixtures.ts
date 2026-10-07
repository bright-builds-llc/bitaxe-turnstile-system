#!/usr/bin/env bun
/** Public RFC 8032 test key only; never reads operational signing inputs. Firmware ADR-0033 soak vectors. */
import { writeFile } from "node:fs/promises";
import { signWorkerLeaseAuthorization, type WorkLeaseAuthorityTrust } from "../web/worker-lease-authorization";
import { parseWorkerLeaseGrant } from "../web/worker-controller";
import controller from "../conformance/bwg-worker-controller-0.4/fixtures.json";
const seed = Buffer.from("302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex");
const privateKey = await crypto.subtle.importKey("pkcs8", seed, "Ed25519", false, ["sign"]);
const trust: WorkLeaseAuthorityTrust = { profile: "bwg-worker-deployment-trust/0.2", issuer: "fixture-soak-allowance", audience: "bwg-worker-controller/0.4", role: "work_lease_authority", keys: [{ kid: "rfc8032", kty: "OKP", crv: "Ed25519", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo", alg: "Ed25519", use: "sig", key_ops: ["verify"] }] };
const binding = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const soakAllowance = { schema: "worker-soak-allowance-v1", id: "AAAAAAAAAAAAAAAAAAAAAA", ordinal: 1, maximumActiveMilliseconds: 619050 };
const vectors = [];
for (const [index, hardwareProfile] of (["upstream-default", "conservative"] as const).entries()) {
  const { authorization: _authorization, ...request } = parseWorkerLeaseGrant({ ...controller.lease, durationMilliseconds: 60000, renewAfterMilliseconds: 20000, hardwareProfile, soakAllowance });
  const input = { operation: "start" as const, activeChallengeId: request.challengeId, controlSessionBindingSha256: binding, request };
  const authorization = await signWorkerLeaseAuthorization({ input, sequence: String(index + 1), kid: "rfc8032", issuer: trust.issuer, audience: trust.audience, privateKey });
  vectors.push({ hardwareProfile, input, grant: { ...request, authorization } });
}
await writeFile("conformance/bwg-worker-controller-0.4/soak-allowance-vectors.json", JSON.stringify({ classification: "public-rfc8032-conformance-only", trust, vectors }, null, 2) + "\n");
