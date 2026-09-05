import { expect, test } from "bun:test";
import { probeWorkerSerialTransport } from "./worker-serial-probe";

test("probe rejects missing request bytes even when response padding has the requested size", async () => {
  // Arrange
  const response = async (payload: { padding: string; responsePaddingBytes: number }) => ({
    padding: "x".repeat(payload.responsePaddingBytes), requestPaddingBytes: payload.padding.length - 1,
  });
  // Act / Assert
  await expect(probeWorkerSerialTransport("probe", 100, response)).rejects.toMatchObject({ category: "probe_mismatch" });
});

test("probe fills both exact payload bounds and confirms received request size", async () => {
  // Arrange
  const response = async (payload: { padding: string; responsePaddingBytes: number }) => ({
    padding: "x".repeat(payload.responsePaddingBytes), requestPaddingBytes: payload.padding.length,
  });
  // Act
  const result = await probeWorkerSerialTransport("probe", undefined, response);
  // Assert
  expect(result.requestPayloadBytes).toBe(65536);
  expect(result.responsePayloadBytes).toBe(65536);
});
