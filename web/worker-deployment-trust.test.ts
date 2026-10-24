import { expect, test } from "bun:test";

import controllerFixtures from "../conformance/bwg-worker-controller-0.4/fixtures.json";
import usbFixtures from "../conformance/bwg-worker-serial-0.2/fixtures.json";
import {
  parseWorkerDeploymentTrust,
  signWorkerControllerCapability,
  type UnsignedWorkerControllerCapability,
} from "./worker-deployment-trust";
import { encodeBase64Url, sha256Base64UrlBytes } from "./crypto-bytes";
import { canonicalJson } from "./headless-values";
import { verifyWorkerControllerCapability } from "./worker-controller";
import { parseWorkerSerialManifest } from "./worker-serial";

test("signs an Ultra 205 capability with only the Update Authority", async () => {
  // Arrange
  const update = await key("development-update-authority-01");
  const lease = await key("development-lease-authority-01");
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
  const { attestation: _attestation, ...fixtureCapability } =
    controllerFixtures.capabilities;
  const unsignedCapability = {
    ...fixtureCapability,
    board: {
      model: "bitaxe-ultra",
      revision: "205",
      usbTransport: "web_serial",
    },
  } as UnsignedWorkerControllerCapability;
  const manifest = parseWorkerSerialManifest(
    usbFixtures.manifest,
  );

  // Act
  const signed = await signWorkerControllerCapability({
    capability: unsignedCapability,
    manifest,
    kid: update.publicJwk.kid,
    privateKey: update.privateKey,
  });

  // Assert
  await expect(verifyWorkerControllerCapability(
    signed,
    manifest,
    trust.updateAuthority.keys,
  )).resolves.toMatchObject({
    board: { model: "bitaxe-ultra", revision: "205" },
  });
  await expect(verifyWorkerControllerCapability(
    signed,
    manifest,
    trust.workLeaseAuthority.keys,
  )).rejects.toThrow("capability attestation is invalid");
});

test("signs a Gamma 601 capability that Worker admission verifies", async () => {
  // Arrange
  const update = await key("development-update-authority-01");
  const manifest = parseWorkerSerialManifest(usbFixtures.manifest);

  // Act
  const signed = await signWorkerControllerCapability({
    capability: unsignedCapability("bitaxe-gamma", "601"),
    manifest,
    kid: update.publicJwk.kid,
    privateKey: update.privateKey,
  });

  // Assert
  await expect(verifyWorkerControllerCapability(
    signed,
    manifest,
    [update.publicJwk],
  )).resolves.toMatchObject({
    board: { model: "bitaxe-gamma", revision: "601" },
    attestation: { claims: { board: { model: "bitaxe-gamma", revision: "601" } } },
  });
});

test.each([
  ["an unknown Gamma revision", "bitaxe-gamma", "204"],
  ["the Ultra model with the Gamma revision", "bitaxe-ultra", "601"],
  ["the Gamma model with the Ultra revision", "bitaxe-gamma", "205"],
] as const)("refuses to sign %s", async (_name, model, revision) => {
  // Arrange
  const update = await key("development-update-authority-01");

  // Act
  const signing = signWorkerControllerCapability({
    capability: unsignedCapability(model, revision),
    manifest: parseWorkerSerialManifest(usbFixtures.manifest),
    kid: update.publicJwk.kid,
    privateKey: update.privateKey,
  });

  // Assert
  await expect(signing).rejects.toThrow("Worker deployment trust is invalid");
});

test("Worker admission refuses a validly signed capability for an unknown board", async () => {
  // Arrange
  const update = await key("development-update-authority-01");
  const manifest = parseWorkerSerialManifest(usbFixtures.manifest);
  const capability = unsignedCapability("bitaxe-gamma", "204");
  const claims = {
    profile: "bwg-reference-firmware-capability/0.2",
    protocolVersion: capability.protocolVersion,
    board: { model: "bitaxe-gamma", revision: "204" },
    firmware: capability.firmware,
    compatibility: capability.compatibility,
    transportProfile: capability.transportProfile,
    serialManifestSha256: await sha256Base64UrlBytes(
      new TextEncoder().encode(canonicalJson(manifest)),
    ),
  };
  const signingInput = [
    { alg: "Ed25519", kid: update.publicJwk.kid, typ: "bwg-worker-capability+jws" },
    claims,
  ].map((part) => encodeBase64Url(new TextEncoder().encode(canonicalJson(part))))
    .join(".");
  const signature = await crypto.subtle.sign(
    "Ed25519",
    update.privateKey,
    new TextEncoder().encode(signingInput).buffer,
  );
  const forged = {
    ...capability,
    attestation: {
      claims,
      compactJws: signingInput + "." + encodeBase64Url(new Uint8Array(signature)),
    },
  };

  // Act
  const admission = verifyWorkerControllerCapability(
    forged as Parameters<typeof verifyWorkerControllerCapability>[0],
    manifest,
    [update.publicJwk],
  );

  // Assert
  await expect(admission).rejects.toThrow("Worker Controller 0.4 capability is invalid");
});

test("rejects low-order authority keys and same-role public-key aliases", async () => {
  // Arrange
  const update = await key("development-update-authority-01");
  const lease = await key("development-lease-authority-01");
  const base = {
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
  };
  const lowOrderKeys = [
    "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "xxdqcD1N2E-6PAt2DRBnDyogU_osOczGTsf9d5KsA3o",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIA",
    "JuiVj8KyJ7BFw_SJ8u-Y8NXfrAXTxjM5sTgCiG1T_AU",
    "7P_______________________________________38",
    "JuiVj8KyJ7BFw_SJ8u-Y8NXfrAXTxjM5sTgCiG1T_IU",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "xxdqcD1N2E-6PAt2DRBnDyogU_osOczGTsf9d5KsA_o",
  ];

  // Act / Assert
  for (const x of lowOrderKeys) {
    expect(() => parseWorkerDeploymentTrust({
      ...base,
      updateAuthority: {
        ...base.updateAuthority,
        keys: [{ ...update.publicJwk, x }],
      },
    })).toThrow();
    expect(() => parseWorkerDeploymentTrust({
      ...base,
      workLeaseAuthority: {
        ...base.workLeaseAuthority,
        keys: [{ ...lease.publicJwk, x }],
      },
    })).toThrow();
  }
  expect(() => parseWorkerDeploymentTrust({
    ...base,
    updateAuthority: {
      ...base.updateAuthority,
      keys: [
        update.publicJwk,
        { ...update.publicJwk, kid: "development-update-authority-02" },
      ],
    },
  })).toThrow();
  expect(() => parseWorkerDeploymentTrust({
    ...base,
    workLeaseAuthority: {
      ...base.workLeaseAuthority,
      keys: [
        lease.publicJwk,
        { ...lease.publicJwk, kid: "development-lease-authority-02" },
      ],
    },
  })).toThrow();
});

function unsignedCapability(
  model: string,
  revision: string,
): UnsignedWorkerControllerCapability {
  const { attestation: _attestation, ...fixtureCapability } =
    controllerFixtures.capabilities;
  return {
    ...fixtureCapability,
    board: { model, revision, usbTransport: "web_serial" },
  } as UnsignedWorkerControllerCapability;
}

async function key(kid: string) {
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  if (!publicKey.x) throw new Error("fixture key is missing x");
  return {
    privateKey: pair.privateKey,
    publicJwk: {
      kid,
      kty: "OKP",
      crv: "Ed25519",
      x: publicKey.x,
      alg: "Ed25519",
      use: "sig",
      key_ops: ["verify"],
    },
  } as const;
}
