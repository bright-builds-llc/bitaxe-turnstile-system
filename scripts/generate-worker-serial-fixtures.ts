#!/usr/bin/env bun
/** Generates public conformance artifacts. Fresh non-production keys exist only in memory. */
import { writeFile } from "node:fs/promises";
import { encodeBase64Url, sha256Base64UrlBytes } from "../web/crypto-bytes";
import { canonicalJson } from "../web/headless-values";
import {
  WORKER_SERIAL_MANIFEST,
  workerSerialManifestSha256,
} from "../web/worker-serial";
import {
  signWorkerControllerCapability,
  parseWorkerDeploymentTrust,
} from "../web/worker-deployment-trust";
import { signWorkerLeaseAuthorization } from "../web/worker-lease-authorization";
import { createWorkerPossessionChallenge } from "../web/worker-possession";
import negativeCases from "../conformance/bwg-worker-deployment-trust-0.2/negative-cases.json";
import priorPossessionFixtures from "../conformance/bwg-worker-possession-0.2/fixtures.json";
import controllerFixtures from "../conformance/bwg-worker-controller-0.4/fixtures.json";

async function key(kid: string) {
  const pair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    privateKey: pair.privateKey,
    publicJwk: {
      kid,
      kty: "OKP",
      crv: "Ed25519",
      x: String(exported.x),
      alg: "Ed25519",
      use: "sig",
      key_ops: ["verify"],
    },
  };
}
async function json(path: string, value: unknown) {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n");
}
const update = await key("fixture-serial-update");
const lease = await key("fixture-serial-lease");
// Public RFC 8032 test vector 1; never a production or deployment identity.
const rfcSeed = new Uint8Array(
  Buffer.from(
    "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
    "hex",
  ),
);
const pkcs8 = new Uint8Array([
  ...new Uint8Array(Buffer.from("302e020100300506032b657004220420", "hex")),
  ...rfcSeed,
]);
const identity = {
  privateKey: await crypto.subtle.importKey("pkcs8", pkcs8, "Ed25519", false, [
    "sign",
  ]),
  publicJwk: {
    kid: "rfc8032-vector-1",
    kty: "OKP",
    crv: "Ed25519",
    x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
    alg: "Ed25519",
    use: "sig",
    key_ops: ["verify"],
  },
};
const { kid: _identityKid, ...deviceIdentityJwk } = identity.publicJwk;
const trust = parseWorkerDeploymentTrust({
  profile: "bwg-worker-deployment-trust/0.2",
  updateAuthority: {
    issuer: "development-update-authority",
    audience: "bwg-reference-firmware-capability/0.2",
    role: "update_authority",
    keys: [update.publicJwk],
  },
  workLeaseAuthority: {
    profile: "bwg-worker-deployment-trust/0.2",
    issuer: "development-worker-lease-authority",
    audience: "bwg-worker-controller/0.4",
    role: "work_lease_authority",
    keys: [lease.publicJwk],
  },
});
const capabilityInput = {
  capability: {
    protocolVersion: "bwg-worker-controller/0.4" as const,
    board: {
      model: "bitaxe-ultra",
      revision: "205",
      usbTransport: "web_serial" as const,
    },
    firmware: { name: "bright-builds-reference-firmware", version: "0.1.0" },
    compatibility: {
      referenceFirmware: true,
      workLease: "supported" as const,
      miningBaselineRestoration: "supported" as const,
      settingsPreservation: "compatible" as const,
    },
    transportProfile: "bwg-worker-serial/0.1" as const,
  },
  manifest: WORKER_SERIAL_MANIFEST,
};
const capability = await signWorkerControllerCapability({
  ...capabilityInput,
  kid: update.publicJwk.kid,
  privateKey: update.privateKey,
});
const common = {
  possessionNonce: encodeBase64Url(new Uint8Array(32).fill(1)),
  challengeBindingSha256: await sha256Base64UrlBytes(
    new TextEncoder().encode("fixture-challenge"),
  ),
  controllerCapabilitySha256: await sha256Base64UrlBytes(
    new TextEncoder().encode(canonicalJson(capability)),
  ),
  sessionId: encodeBase64Url(new Uint8Array(16).fill(2)),
  hostNonce: encodeBase64Url(new Uint8Array(32).fill(3)),
  deviceNonce: encodeBase64Url(new Uint8Array(32).fill(4)),
  serialManifestSha256: await workerSerialManifestSha256(),
};
async function possession(
  purpose: "initial_admission" | "transport_reacquisition",
  requestId: string,
) {
  const request = {
    profile: "bwg-worker-possession/0.2" as const,
    requestId,
    command: "prove_possession" as const,
    payload: { ...common, purpose },
  };
  const claims = {
    profile: "bwg-worker-possession-proof/0.2",
    ...request.payload,
    firmwareSourceCommit: "a".repeat(40),
    appElfSha256: "b".repeat(64),
    deviceIdentityJwk,
  };
  const header = encodeBase64Url(
    new TextEncoder().encode(
      canonicalJson({ alg: "Ed25519", typ: "bwg-worker-possession+jws" }),
    ),
  );
  const payload = encodeBase64Url(
    new TextEncoder().encode(canonicalJson(claims)),
  );
  const signature = await crypto.subtle.sign(
    "Ed25519",
    identity.privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return {
    request,
    response: {
      profile: request.profile,
      requestId,
      ok: true as const,
      result: {
        claims,
        compactJws: `${header}.${payload}.${encodeBase64Url(new Uint8Array(signature))}`,
      },
    },
  };
}
const initialAdmission = await possession(
  "initial_admission",
  "pos_initial_01",
);
const verified = await createWorkerPossessionChallenge({
  requestId: initialAdmission.request.requestId,
  ...initialAdmission.request.payload,
}).verify(initialAdmission.response);
const reacquisition = await possession(
  "transport_reacquisition",
  "pos_reacquire_01",
);
const { authorization: _startAuthorization, ...startRequest } =
  controllerFixtures.lease;
const { authorization: _renewAuthorization, ...renewRequest } =
  controllerFixtures.renewal;
const startInput = {
  operation: "start" as const,
  activeChallengeId: startRequest.challengeId,
  controlSessionBindingSha256: verified.controlSessionBindingSha256,
  request: {
    ...startRequest,
    protocolVersion: "bwg-worker-controller/0.4" as const,
  },
};
const renewInput = {
  operation: "renew" as const,
  activeChallengeId: startRequest.challengeId,
  controlSessionBindingSha256: verified.controlSessionBindingSha256,
  request: {
    ...renewRequest,
    protocolVersion: "bwg-worker-controller/0.4" as const,
  },
};
async function authorize(
  input: typeof startInput | typeof renewInput,
  sequence: string,
) {
  return signWorkerLeaseAuthorization({
    input,
    sequence,
    kid: lease.publicJwk.kid,
    issuer: trust.workLeaseAuthority.issuer,
    audience: trust.workLeaseAuthority.audience,
    privateKey: lease.privateKey,
  });
}
const startAuthorization = await authorize(startInput, "1");
const renewAuthorization = await authorize(renewInput, "2");
const directory = "conformance/bwg-worker-deployment-trust-0.2/";
await json(directory + "trust.json", trust);
await json(directory + "signed-capability.json", capability);
await json(directory + "ultra205-capability-input.json", capabilityInput);
await json(directory + "start-input.json", startInput);
await json(directory + "renew-input.json", renewInput);
await json(directory + "start-authorization.json", {
  compactJws: startAuthorization,
});
await json(directory + "renew-authorization.json", {
  compactJws: renewAuthorization,
});
await json(directory + "fixtures.json", {
  profile: "bwg-worker-deployment-trust/0.2",
  classification: "non_production_conformance_only",
  maximumCompactJwsBytes: 481,
  controllerAuthorizationLimitBytes: 512,
  authorizationBoundaries: [
    { bytes: 511, expected: "controller_syntax_accepted" },
    { bytes: 512, expected: "controller_syntax_accepted" },
    { bytes: 513, expected: "controller_syntax_rejected" },
  ],
  trust,
  ultra205: { capabilityInput, signedCapability: capability },
  start: {
    input: startInput,
    artifact: {
      profile: "bwg-worker-lease-authorization-artifact/0.1",
      operation: "start",
      sequence: "1",
      authorization: startAuthorization,
    },
  },
  renew: {
    input: renewInput,
    artifact: {
      profile: "bwg-worker-lease-authorization-artifact/0.1",
      operation: "renew",
      sequence: "2",
      authorization: renewAuthorization,
    },
  },
  negativeCases,
});
await json("conformance/bwg-worker-possession-0.2/fixtures.json", {
  ...priorPossessionFixtures,
  profile: "bwg-worker-possession/0.2",
  proofProfile: "bwg-worker-possession-proof/0.2",
  fixtureIdentity: {
    classification: "non_production_conformance_only",
    publicJwk: deviceIdentityJwk,
    fingerprintSha256: verified.deviceIdentityFingerprint,
  },
  initialAdmission,
  reacquisition,
  controlSessionBindingSha256: verified.controlSessionBindingSha256,
});
await json("conformance/bwg-worker-controller-0.4/fixtures.json", {
  ...controllerFixtures,
  capabilities: capability,
  usbVectors: controllerFixtures.usbVectors.map((vector) =>
    vector.request.command === "discover"
      ? { ...vector, response: { ...vector.response, result: capability } }
      : vector,
  ),
});
console.log("worker_serial_fixtures=generated public_only=true");
