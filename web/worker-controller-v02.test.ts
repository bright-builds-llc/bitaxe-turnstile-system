import { describe, expect, test } from "bun:test";

import controllerFixtures from "../conformance/bwg-worker-controller-0.2/fixtures.json";
import transportFixtures from "../conformance/bwg-worker-usb-0.1/fixtures.json";
import {
  WORKER_CONTROLLER_V02_PROTOCOL_VERSION,
  parseWorkerControllerCapabilitiesV02,
  parseWorkerControllerStatusV02,
  parseWorkerLeaseGrantV02,
  parseWorkerLeaseRenewalV02,
  verifyWorkerControllerCapabilityV02,
} from "./worker-controller-v02";
import { parseWorkerUsbTransportProfile } from "./worker-usb-profile";

describe("Worker Controller 0.2 profile", () => {
  test("binds Reference Firmware capability to the separated WebUSB profile", () => {
    // Arrange
    const capability = controllerFixtures.capabilities;

    // Act
    const parsed = parseWorkerControllerCapabilitiesV02(capability);

    // Assert
    expect(parsed.protocolVersion).toBe(WORKER_CONTROLLER_V02_PROTOCOL_VERSION);
    expect(parsed.board.usbTransport).toBe("web_usb");
    expect(parsed.transportProfile).toBe("bwg-worker-usb/0.1");
    expect(JSON.stringify(parsed)).not.toMatch(/credential|password|serial|identity/i);
  });

  test("verifies signed Reference Firmware capability against the exact application descriptor", async () => {
    // Arrange
    const capability = parseWorkerControllerCapabilitiesV02(controllerFixtures.capabilities);
    const descriptor = parseWorkerUsbTransportProfile(transportFixtures.topology).application
      .descriptor;

    // Act
    const verified = await verifyWorkerControllerCapabilityV02(
      capability,
      descriptor,
      controllerFixtures.updateAuthorityKeys,
    );

    // Assert
    expect(verified).toEqual(capability);
  });

  test("rejects a forged Reference Firmware capability signature", async () => {
    // Arrange
    const tampered = structuredClone(controllerFixtures.capabilities);
    tampered.attestation.compactJws = `${tampered.attestation.compactJws.slice(0, -1)}A`;
    const capability = parseWorkerControllerCapabilitiesV02(tampered);
    const descriptor = parseWorkerUsbTransportProfile(transportFixtures.topology).application
      .descriptor;

    // Act
    const verification = verifyWorkerControllerCapabilityV02(
      capability,
      descriptor,
      controllerFixtures.updateAuthorityKeys,
    );

    // Assert
    await expect(verification).rejects.toThrow(
      "Worker Controller 0.2 capability attestation is invalid",
    );
  });

  test("snapshots capability and trust inputs before asynchronous verification", async () => {
    // Arrange
    const capability = parseWorkerControllerCapabilitiesV02(controllerFixtures.capabilities);
    const descriptor = parseWorkerUsbTransportProfile(transportFixtures.topology).application
      .descriptor;
    const trustedKeys = structuredClone(controllerFixtures.updateAuthorityKeys);

    // Act
    const verification = verifyWorkerControllerCapabilityV02(
      capability,
      descriptor,
      trustedKeys,
    );
    capability.firmware.version = "9.9.9";
    Object.assign(descriptor.control, { interfaceNumber: 4 });
    const maybeKey = trustedKeys[0];
    if (!maybeKey) throw new Error("trusted fixture key is missing");
    maybeKey.x = "A".repeat(43);
    const verified = await verification;

    // Assert
    expect(verified.firmware.version).toBe("0.2.0");
    expect(verified.attestation as unknown).toEqual(controllerFixtures.capabilities.attestation);
  });

  test("preserves bounded Work Lease grant semantics under 0.2", () => {
    // Arrange
    const grant = exactGrant();

    // Act
    const parsed = parseWorkerLeaseGrantV02(grant);

    // Assert
    expect(parsed).toEqual(grant);
  });

  test("keeps Controller 0.2 status metadata-only", () => {
    // Arrange
    const grant = exactGrant();
    const status = {
      protocolVersion: "bwg-worker-controller/0.2",
      state: "mining",
      monotonicMilliseconds: 0,
      lease: {
        leaseId: grant.leaseId,
        challengeId: grant.challengeId,
        renewAtMonotonicMilliseconds: 20_000,
        expiresAtMonotonicMilliseconds: 60_000,
      },
      restoration: { status: "pending" },
    } as const;

    // Act
    const parsed = parseWorkerControllerStatusV02(status);

    // Assert
    expect(parsed).toEqual(status);
    expect(JSON.stringify(parsed)).not.toMatch(/authorization|username|password/i);
  });

  test("requires a fresh bounded 0.2 renewal for the exact lease", () => {
    // Arrange
    const renewal = {
      protocolVersion: "bwg-worker-controller/0.2",
      leaseId: "lease_fixture_02",
      authorization: "fixture-renewal-authentication",
      durationMilliseconds: 60_000,
      renewAfterMilliseconds: 20_000,
    } as const;

    // Act
    const parsed = parseWorkerLeaseRenewalV02(renewal);
    const wrongProfile = () => parseWorkerLeaseRenewalV02({
      ...renewal,
      protocolVersion: "bwg-worker-controller/0.1",
    });

    // Assert
    expect(parsed).toEqual(renewal);
    expect(wrongProfile).toThrow("Work Lease 0.2 renewal is invalid");
  });
});

function exactGrant() {
  return {
    protocolVersion: "bwg-worker-controller/0.2",
    leaseId: "lease_fixture_02",
    challengeId: "challenge_00000000000000000000000000000001",
    authorization: "fixture-authentication-not-a-production-secret",
    durationMilliseconds: 60_000,
    renewAfterMilliseconds: 20_000,
    stratum: {
      endpoint: "stratum+tcp://127.0.0.1:3333/",
      username: "fixture-session-user",
      password: "fixture-session-password",
    },
  } as const;
}
