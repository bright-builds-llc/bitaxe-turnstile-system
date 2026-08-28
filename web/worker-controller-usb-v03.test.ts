import { describe, expect, test } from "bun:test";

import {
  decodeWorkerControllerUsbRequestV03,
  decodeWorkerControllerUsbResponseV03,
  encodeWorkerControllerUsbMessageV03,
} from "./worker-controller-usb-v03";

describe("Worker Controller 0.3 USB bulk framing", () => {
  test("round-trips one correlated start request without sharing a log stream", () => {
    // Arrange
    const request = {
      protocolVersion: "bwg-worker-controller/0.3",
      requestId: "usb_v03_start",
      command: "start_lease",
      payload: {
        protocolVersion: "bwg-worker-controller/0.3",
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
    const encoded = encodeWorkerControllerUsbMessageV03(request);
    const decoded = decodeWorkerControllerUsbRequestV03(encoded);

    // Assert
    expect(decoded).toEqual(request);
    expect(new TextDecoder().decode(encoded).split("\n")).toHaveLength(2);
  });

  test("accepts one correlated metadata-only success response", () => {
    // Arrange
    const successful = encodeWorkerControllerUsbMessageV03({
      protocolVersion: "bwg-worker-controller/0.3",
      requestId: "usb_v03_status",
      ok: true,
      result: {
        protocolVersion: "bwg-worker-controller/0.3",
        state: "baseline",
        monotonicMilliseconds: 7,
        restoration: { status: "not_required" },
      },
    });
    // Act
    const success = decodeWorkerControllerUsbResponseV03(successful);

    // Assert
    expect(success).toMatchObject({ requestId: "usb_v03_status", ok: true });
  });

  test("replaces device-supplied error text", () => {
    // Arrange
    const rejected = encodeWorkerControllerUsbMessageV03({
      protocolVersion: "bwg-worker-controller/0.3",
      requestId: "usb_v03_status",
      ok: false,
      error: {
        code: "command_rejected",
        message: "password=must-not-escape",
      },
    });

    // Act
    const failure = decodeWorkerControllerUsbResponseV03(rejected);

    // Assert
    expect(failure).toEqual({
      protocolVersion: "bwg-worker-controller/0.3",
      requestId: "usb_v03_status",
      ok: false,
      error: {
        code: "command_rejected",
        message: "Worker Controller command was rejected",
      },
    });
  });
});
