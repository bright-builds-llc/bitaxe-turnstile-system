import { expect, test } from "bun:test";

import controllerFixtures from "../conformance/bwg-worker-controller-0.3/fixtures.json";
import usbFixtures from "../conformance/bwg-worker-usb-0.2/fixtures.json";
import {
  parseWorkerDeploymentTrust,
  signWorkerControllerCapabilityV03,
  type UnsignedWorkerControllerCapabilityV03,
} from "./worker-deployment-trust";
import { verifyWorkerControllerCapabilityV03 } from "./worker-controller-v03";
import { parseWorkerUsbApplicationDescriptor } from "./worker-usb-profile";

test("signs an Ultra 205 capability with only the Update Authority", async () => {
  // Arrange
  const update = await key("development-update-authority-01");
  const lease = await key("development-lease-authority-01");
  const trust = parseWorkerDeploymentTrust({
    profile: "bwg-worker-deployment-trust/0.1",
    updateAuthority: {
      issuer: "development-update-authority",
      audience: "bwg-reference-firmware-capability/0.1",
      role: "update_authority",
      keys: [update.publicJwk],
    },
    workLeaseAuthority: {
      profile: "bwg-worker-deployment-trust/0.1",
      issuer: "development-worker-lease-authority",
      audience: "bwg-worker-controller/0.3",
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
      usbTransport: "web_usb",
    },
  } as UnsignedWorkerControllerCapabilityV03;
  const descriptor = parseWorkerUsbApplicationDescriptor(
    usbFixtures.topology.application.descriptor,
  );

  // Act
  const signed = await signWorkerControllerCapabilityV03({
    capability: unsignedCapability,
    descriptor,
    kid: update.publicJwk.kid,
    privateKey: update.privateKey,
  });

  // Assert
  await expect(verifyWorkerControllerCapabilityV03(
    signed,
    descriptor,
    trust.updateAuthority.keys,
  )).resolves.toMatchObject({
    board: { model: "bitaxe-ultra", revision: "205" },
  });
  await expect(verifyWorkerControllerCapabilityV03(
    signed,
    descriptor,
    trust.workLeaseAuthority.keys,
  )).rejects.toThrow("capability attestation is invalid");
});

test("rejects low-order authority keys and same-role public-key aliases", async () => {
  // Arrange
  const update = await key("development-update-authority-01");
  const lease = await key("development-lease-authority-01");
  const base = {
    profile: "bwg-worker-deployment-trust/0.1",
    updateAuthority: {
      issuer: "development-update-authority",
      audience: "bwg-reference-firmware-capability/0.1",
      role: "update_authority",
      keys: [update.publicJwk],
    },
    workLeaseAuthority: {
      profile: "bwg-worker-deployment-trust/0.1",
      issuer: "development-worker-lease-authority",
      audience: "bwg-worker-controller/0.3",
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
