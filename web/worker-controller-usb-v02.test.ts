import { describe, expect, test } from "bun:test";

import {
  decodeWorkerControllerUsbRequestV02,
  decodeWorkerControllerUsbResponseV02,
  encodeWorkerControllerUsbMessageV02,
} from "./worker-controller-usb-v02";

describe("Worker Controller 0.2 USB bulk framing", () => {
  test("round-trips one correlated start request without sharing a log stream", () => {
    // Arrange
    const request = {
      protocolVersion: "bwg-worker-controller/0.2",
      requestId: "usb_v02_start",
      command: "start_lease",
      payload: {
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
      },
    } as const;

    // Act
    const encoded = encodeWorkerControllerUsbMessageV02(request);
    const decoded = decodeWorkerControllerUsbRequestV02(encoded);

    // Assert
    expect(decoded).toEqual(request);
    expect(new TextDecoder().decode(encoded).split("\n")).toHaveLength(2);
  });

  test("accepts one correlated metadata-only success response", () => {
    // Arrange
    const successful = encodeWorkerControllerUsbMessageV02({
      protocolVersion: "bwg-worker-controller/0.2",
      requestId: "usb_v02_status",
      ok: true,
      result: {
        protocolVersion: "bwg-worker-controller/0.2",
        state: "baseline",
        monotonicMilliseconds: 7,
        restoration: { status: "not_required" },
      },
    });
    // Act
    const success = decodeWorkerControllerUsbResponseV02(successful);

    // Assert
    expect(success).toMatchObject({ requestId: "usb_v02_status", ok: true });
  });

  test("replaces device-supplied error text", () => {
    // Arrange
    const rejected = encodeWorkerControllerUsbMessageV02({
      protocolVersion: "bwg-worker-controller/0.2",
      requestId: "usb_v02_status",
      ok: false,
      error: {
        code: "command_rejected",
        message: "password=must-not-escape",
      },
    });

    // Act
    const failure = decodeWorkerControllerUsbResponseV02(rejected);

    // Assert
    expect(failure).toEqual({
      protocolVersion: "bwg-worker-controller/0.2",
      requestId: "usb_v02_status",
      ok: false,
      error: {
        code: "command_rejected",
        message: "Worker Controller command was rejected",
      },
    });
  });
});
