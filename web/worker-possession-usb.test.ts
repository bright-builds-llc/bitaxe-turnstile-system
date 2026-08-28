import { describe, expect, test } from "bun:test";

import {
  decodeWorkerPossessionRequest,
  decodeWorkerPossessionResponse,
  encodeWorkerPossessionMessage,
} from "./worker-possession-usb";
import fixtures from "../conformance/bwg-worker-possession-0.1/fixtures.json";

describe("Worker possession USB framing", () => {
  test("round-trips one strict possession request", () => {
    // Arrange
    const request = {
      profile: "bwg-worker-possession/0.1",
      requestId: "pos_fixture_01",
      command: "prove_possession",
      payload: {
        purpose: "initial_admission",
        possessionNonce: "B".repeat(43),
        challengeBindingSha256: "C".repeat(43),
        controllerCapabilitySha256: "D".repeat(43),
        applicationDescriptorSha256: "E".repeat(43),
      },
    } as const;

    // Act
    const decoded = decodeWorkerPossessionRequest(encodeWorkerPossessionMessage(request));

    // Assert
    expect(decoded).toEqual(request);
  });

  test("round-trips a reacquisition request without putting the trusted fingerprint on wire", () => {
    // Arrange
    const request = fixtures.reacquisition.request;

    // Act
    const decoded = decodeWorkerPossessionRequest(encodeWorkerPossessionMessage(request));

    // Assert
    expect(decoded as unknown).toEqual(request);
    expect(JSON.stringify(decoded)).not.toMatch(/fingerprint/i);
  });

  test("normalizes a device-supplied possession failure", () => {
    // Arrange
    const frame = encodeWorkerPossessionMessage({
      profile: "bwg-worker-possession/0.1",
      requestId: "pos_fixture_01",
      ok: false,
      error: { code: "proof_unavailable", message: "serial=secret password=secret" },
    });

    // Act
    const decoded = decodeWorkerPossessionResponse(frame);

    // Assert
    expect(decoded).toEqual({
      profile: "bwg-worker-possession/0.1",
      requestId: "pos_fixture_01",
      ok: false,
      error: {
        code: "proof_unavailable",
        message: "Worker possession proof was unavailable",
      },
    });
  });

  test("rejects an object that only coerces to a known failure code", () => {
    // Arrange
    const frame = encodeWorkerPossessionMessage({
      profile: "bwg-worker-possession/0.1",
      requestId: "pos_fixture_01",
      ok: false,
      error: {
        code: { toString: () => "proof_unavailable" },
        message: "must not be accepted",
      },
    });

    // Act
    const decoding = () => decodeWorkerPossessionResponse(frame);

    // Assert
    expect(decoding).toThrow("Worker possession proof is invalid");
  });
});
