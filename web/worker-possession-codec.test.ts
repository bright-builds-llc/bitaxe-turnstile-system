import { canonicalJson } from "./headless-values";
import { expect, test } from "bun:test";
import fixtures from "../conformance/bwg-worker-possession-0.2/fixtures.json";
import {
  encodeWorkerPossessionMessage,
  decodeWorkerPossessionRequest,
  decodeWorkerPossessionResponse,
} from "./worker-possession-codec";

test("current possession codec preserves exact single-frame request and proof", () => {
  // Arrange / Act / Assert
  expect(fixtures.initialAdmission.request).toEqual(
    decodeWorkerPossessionRequest(
      encodeWorkerPossessionMessage(fixtures.initialAdmission.request),
    ),
  );
  expect(canonicalJson(fixtures.initialAdmission.response)).toBe(
    canonicalJson(
      decodeWorkerPossessionResponse(
        encodeWorkerPossessionMessage(fixtures.initialAdmission.response),
      ),
    ),
  );
});
test("possession codec rejects oversized, missing delimiter, second frame and invalid UTF8", () => {
  // Arrange
  const frame = encodeWorkerPossessionMessage(
    fixtures.initialAdmission.request,
  );
  // Act / Assert
  for (const invalid of [
    new Uint8Array(65537),
    frame.slice(0, -1),
    new Uint8Array([...frame, ...frame]),
    new Uint8Array([255, 10]),
  ])
    expect(() => decodeWorkerPossessionRequest(invalid)).toThrow();
});
