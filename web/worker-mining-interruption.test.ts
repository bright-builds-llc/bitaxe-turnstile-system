import { expect, test } from "bun:test";
import { interruptionHarness } from "./worker-read-interruption.test-support";
import { miningInterruptionFixture } from "./worker-mining-interruption.fixture";
import { reviewDeviceSerialTrace } from "./worker-serial-trace-review";

async function mining(withHook = true) {
  const h = await interruptionHarness(withHook);
  await h.controller.requestPermission();
  h.setQualification(structuredClone(miningInterruptionFixture));
  const grant = await h.grant(await h.controller.prepareWorkerLeaseAuthorizationContext("start"));
  await h.controller.startLease(grant);
  return h;
}

test("qualified live loss releases ownership without sending any additional wire records", async () => {
  // Arrange
  const h = await mining();
  const before = h.received.length, writes = h.wireCounts().writes;
  // Act
  const receipt = await h.controller.qualificationAbruptDisconnect();
  // Assert
  expect(receipt).toEqual({ schema: "worker-mining-interruption-v1", generation: 7, workDispatched: 1, workGateRemainingMs: 12000, ownershipReleased: true, controlRecordsSent: 0 });
  expect(h.received.slice(before)).toEqual([]);
  expect(h.wireCounts().writes).toBe(writes);
  expect(h.counts()).toMatchObject({ closed: 1, locked: false, active: true });
  expect(h.controller.exportBrowserSerialTrace().events.some(event => event.stage === "close_completed")).toBeTrue();
  await expect(h.controller.qualificationAbruptDisconnect()).rejects.toThrow();
});

test("live loss requires the explicit qualification hook", async () => {
  // Arrange
  const h = await mining(false);
  const before = h.received.length;
  // Act / Assert
  await expect(h.controller.qualificationAbruptDisconnect()).rejects.toMatchObject({ category: "probe_admission" });
  expect(h.received.length).toBe(before);
  await h.controller.close();
});

test.each([
  { work_dispatched: 0 }, { work_gate_remaining_ms: 3000 },
])("insufficient actual work or headroom never cuts the live connection", async change => {
  // Arrange
  const h = await mining();
  h.setQualification({ ...miningInterruptionFixture, ...change });
  await h.controller.status();
  const before = h.received.length;
  // Act / Assert
  await expect(h.controller.qualificationAbruptDisconnect()).rejects.toMatchObject({ category: "probe_admission" });
  expect(h.received.length).toBe(before);
  expect(h.counts()).toMatchObject({ closed: 0, locked: true });
  await h.controller.close();
});

test("a stale-generation status fails parsing before it can authorize planned loss", async () => {
  // Arrange
  const h = await mining();
  h.setQualification({ ...miningInterruptionFixture, mining_progress: { ...miningInterruptionFixture.mining_progress!, generation: 8 } });
  // Act / Assert
  await expect(h.controller.status()).rejects.toThrow();
  await h.controller.close();
  await expect(h.controller.qualificationAbruptDisconnect()).rejects.toThrow();
});

test("pre-loss journal work cannot consume the observation freshness allowance", async () => {
  // Arrange
  const h = await mining();
  await h.advance(1100);
  // Act / Assert
  await expect(h.controller.qualificationAbruptDisconnect()).rejects.toMatchObject({ category: "probe_admission" });
  await h.controller.close();
});

test("device trace review traverses the authenticated channel and is unavailable while mining", async () => {
  // Arrange
  const h = await interruptionHarness(); await h.controller.requestPermission();
  // Act
  const trace = await h.controller.deviceSerialTraceReview();
  // Assert
  expect(trace.snapshotAvailable).toBeTrue(); expect(trace.current.epoch).toBe(1);
  expect(h.received.at(-1)?.command).toBe("serial_trace_review");
  const grant = await h.grant(await h.controller.prepareWorkerLeaseAuthorizationContext("start"));
  await h.controller.startLease(grant); const before = h.received.length;
  await expect(h.controller.deviceSerialTraceReview()).rejects.toMatchObject({ category: "probe_admission" });
  await expect(reviewDeviceSerialTrace(h.controller)).rejects.toMatchObject({ category: "lease_active" });
  expect(h.received.length).toBe(before); await h.controller.close();
});

test("trace export after Stop obtains new possession before sending its read command", async () => {
  // Arrange
  const h = await mining(); await h.controller.restore("cancelled");
  await expect(h.controller.deviceSerialTraceReview()).rejects.toMatchObject({ category: "probe_admission" });
  const before = h.received.length;
  // Act
  const trace = await reviewDeviceSerialTrace(h.controller);
  // Assert
  expect(trace.snapshotAvailable).toBeTrue();
  expect(h.received.slice(before).filter(frame => frame.kind === "control").map(frame => frame.command)).toEqual(["prove_possession", "serial_trace_review"]);
  await h.controller.close();
});
