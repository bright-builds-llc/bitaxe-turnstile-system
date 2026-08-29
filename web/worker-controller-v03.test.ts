import { describe, expect, test } from "bun:test";

import usbFixtures from "../conformance/bwg-worker-usb-0.1/fixtures.json";
import { encodeBase64Url } from "./crypto-bytes";
import { canonicalJson } from "./headless-values";
import {
  parseWorkerControllerCapabilitiesV03,
  verifyWorkerControllerCapabilityV03,
} from "./worker-controller-v03";
import { parseWorkerUsbTransportProfile } from "./worker-usb-profile";

const capability = {
  protocolVersion: "bwg-worker-controller/0.3",
  board: { model: "bitaxe-gamma", revision: "204", usbTransport: "web_usb" },
  firmware: { name: "bright-builds-reference-firmware", version: "0.3.0" },
  compatibility: {
    referenceFirmware: true,
    workLease: "supported",
    miningBaselineRestoration: "supported",
    settingsPreservation: "compatible",
  },
  transportProfile: "bwg-worker-usb/0.2",
  attestation: {
    claims: {
      profile: "bwg-reference-firmware-capability/0.1",
      protocolVersion: "bwg-worker-controller/0.3",
      board: { model: "bitaxe-gamma", revision: "204" },
      firmware: { name: "bright-builds-reference-firmware", version: "0.3.0" },
      compatibility: {
        referenceFirmware: true,
        workLease: "supported",
        miningBaselineRestoration: "supported",
        settingsPreservation: "compatible",
      },
      transportProfile: "bwg-worker-usb/0.2",
      applicationDescriptorSha256: "rOKO_7whZfy0ntMKM9RIeZNAA3x97tt3rWMAm_QshVA",
    },
    compactJws:
      "eyJhbGciOiJFZDI1NTE5Iiwia2lkIjoidXBkYXRlLWNhcGFiaWxpdHktZml4dHVyZS0wMyIsInR5cCI6ImJ3Zy13b3JrZXItY2FwYWJpbGl0eStqd3MifQ.eyJhcHBsaWNhdGlvbkRlc2NyaXB0b3JTaGEyNTYiOiJyT0tPXzd3aFpmeTBudE1LTTlSSWVaTkFBM3g5N3R0M3JXTUFtX1FzaFZBIiwiYm9hcmQiOnsibW9kZWwiOiJiaXRheGUtZ2FtbWEiLCJyZXZpc2lvbiI6IjIwNCJ9LCJjb21wYXRpYmlsaXR5Ijp7Im1pbmluZ0Jhc2VsaW5lUmVzdG9yYXRpb24iOiJzdXBwb3J0ZWQiLCJyZWZlcmVuY2VGaXJtd2FyZSI6dHJ1ZSwic2V0dGluZ3NQcmVzZXJ2YXRpb24iOiJjb21wYXRpYmxlIiwid29ya0xlYXNlIjoic3VwcG9ydGVkIn0sImZpcm13YXJlIjp7Im5hbWUiOiJicmlnaHQtYnVpbGRzLXJlZmVyZW5jZS1maXJtd2FyZSIsInZlcnNpb24iOiIwLjMuMCJ9LCJwcm9maWxlIjoiYndnLXJlZmVyZW5jZS1maXJtd2FyZS1jYXBhYmlsaXR5LzAuMSIsInByb3RvY29sVmVyc2lvbiI6ImJ3Zy13b3JrZXItY29udHJvbGxlci8wLjMiLCJ0cmFuc3BvcnRQcm9maWxlIjoiYndnLXdvcmtlci11c2IvMC4yIn0.ZisLU-gehxrvKi6ERJhrZavxd6eHnTrpoS5odKhhqSnSaYy5TZgbzDOY25c0_pnvqXg5_eeqlq1vBzir9-YyDQ",
  },
} as const;

const updateAuthorityKeys = [{
  kty: "OKP",
  crv: "Ed25519",
  x: "PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw",
  kid: "update-capability-fixture-03",
  alg: "Ed25519",
  use: "sig",
  key_ops: ["verify"],
  ext: true,
}] as const;

describe("Worker Controller 0.3 profile", () => {
  test("verifies signed Reference Firmware bound to Worker USB 0.2", async () => {
    // Arrange
    const parsed = parseWorkerControllerCapabilitiesV03(capability);
    const descriptor = parseWorkerUsbTransportProfile(usbFixtures.topology).application.descriptor;

    // Act
    const verified = await verifyWorkerControllerCapabilityV03(
      parsed,
      descriptor,
      updateAuthorityKeys,
    );

    // Assert
    expect(verified.transportProfile).toBe("bwg-worker-usb/0.2");
    expect(verified.protocolVersion).toBe("bwg-worker-controller/0.3");
  });

  test("rejects an identity-point Update key even with its universal forgery", async () => {
    // Arrange
    const header = encodeBase64Url(new TextEncoder().encode(canonicalJson({
      alg: "Ed25519",
      kid: "weak-update-key",
      typ: "bwg-worker-capability+jws",
    })));
    const payload = encodeBase64Url(
      new TextEncoder().encode(canonicalJson(capability.attestation.claims)),
    );
    const signature = new Uint8Array(64);
    signature[0] = 0x58;
    signature.fill(0x66, 1, 32);
    signature[32] = 1;
    const forged = parseWorkerControllerCapabilitiesV03({
      ...capability,
      attestation: {
        ...capability.attestation,
        compactJws: `${header}.${payload}.${encodeBase64Url(signature)}`,
      },
    });
    const descriptor = parseWorkerUsbTransportProfile(
      usbFixtures.topology,
    ).application.descriptor;

    // Act
    const result = verifyWorkerControllerCapabilityV03(
      forged,
      descriptor,
      [{
        kty: "OKP",
        crv: "Ed25519",
        x: "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        kid: "weak-update-key",
        alg: "Ed25519",
        use: "sig",
        key_ops: ["verify"],
      }],
    );

    // Assert
    await expect(result).rejects.toThrow("capability attestation is invalid");
  });
});
