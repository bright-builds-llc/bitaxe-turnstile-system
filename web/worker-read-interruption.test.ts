import { expect, test } from "bun:test";
import { interruptionHarness } from "./worker-read-interruption.test-support";

test("qualification closes a fully consumed status while its actual response is pending", async () => {
  // Arrange
  const h = await interruptionHarness();
  await h.controller.requestPermission();
  h.holdStatusAfter(1);
  const creditsBefore = h.wireCounts().credits;
  const commandsBefore = h.received.length;
  // Act
  const receipt = await h.controller.interruptPendingStatusForQualification();
  const writesAfter = h.wireCounts().writes;
  await h.advance(3000);
  // Assert
  expect(receipt).toEqual({ schema: "worker-read-interruption-v1", interrupted: true, request_consumed: true, response_pending: true, ownership_released: true });
  expect(h.wireCounts().heldReplies).toBe(1);
  expect(h.wireCounts().credits - creditsBefore).toBe(2);
  expect(h.received.slice(commandsBefore)).toEqual([{ kind: "control", command: "status" }, { kind: "control", command: "status" }]);
  expect(h.wireCounts().writes).toBe(writesAfter);
  expect(h.counts()).toMatchObject({ closed: 1, locked: false, active: false });
});

test("qualification interruption is unavailable without the explicit hook", async () => {
  // Arrange
  const h = await interruptionHarness(false);
  await h.controller.requestPermission();
  const before = h.received.length;
  // Act / Assert
  await expect(h.controller.interruptPendingStatusForQualification()).rejects.toMatchObject({ category: "probe_admission" });
  expect(h.received.length).toBe(before);
  expect(h.counts()).toMatchObject({ closed: 0, locked: true });
  await h.controller.close();
});

test("an active lease cannot enter the no-mining interruption path", async () => {
  // Arrange
  const h = await interruptionHarness();
  await h.controller.requestPermission();
  const grant = await h.grant(await h.controller.prepareWorkerLeaseAuthorizationContext("start"));
  await h.controller.startLease(grant);
  const before = h.received.length;
  // Act / Assert
  await expect(h.controller.interruptPendingStatusForQualification()).rejects.toMatchObject({ category: "probe_admission" });
  expect(h.received.length).toBe(before);
  expect(h.counts().active).toBeTrue();
  await h.controller.close();
});

test("an unrelated pending read retains exclusive operation ownership", async () => {
  // Arrange
  const h = await interruptionHarness();
  await h.controller.requestPermission();
  h.holdStatusAfter(0);
  const reading = h.controller.status();
  await h.advance(100);
  const before = h.received.length;
  // Act / Assert
  await expect(h.controller.interruptPendingStatusForQualification()).rejects.toMatchObject({ category: "probe_admission" });
  expect(h.received.length).toBe(before);
  h.releaseReply();
  expect((await reading).state).toBe("baseline");
  await h.controller.close();
});

test("qualification excludes concurrent Start and status until its read finishes", async () => {
  // Arrange
  const h = await interruptionHarness();
  await h.controller.requestPermission();
  const grant = await h.grant(await h.controller.prepareWorkerLeaseAuthorizationContext("start"));
  h.holdStatusAfter(0);
  const interrupting = h.controller.interruptPendingStatusForQualification();
  await h.advance(100);
  // Act / Assert
  await expect(h.controller.startLease(grant)).rejects.toMatchObject({ category: "operation_active" });
  await expect(h.controller.status()).rejects.toMatchObject({ category: "operation_active" });
  await expect(h.controller.interruptPendingStatusForQualification()).rejects.toMatchObject({ category: "operation_active" });
  expect(h.received.some(frame => frame.command === "start_lease")).toBeFalse();
  h.releaseReply();
  await interrupting;
  await h.controller.close();
});

test("missing receive credit cannot produce a consumed interruption receipt", async () => {
  // Arrange
  const h = await interruptionHarness();
  await h.controller.requestPermission();
  h.dropCredits();
  const before = h.received.length;
  // Act / Assert
  await expect(h.controller.interruptPendingStatusForQualification()).rejects.toMatchObject({ category: "timeout" });
  await h.controller.close();
  expect(h.received.slice(before)).toEqual([{ kind: "control", command: "status" }]);
  expect(h.counts()).toMatchObject({ closed: 1, locked: false, active: false });
});

test("closing the generation during baseline observation never reports a qualified interruption", async () => {
  // Arrange
  const h = await interruptionHarness();
  await h.controller.requestPermission();
  h.holdStatusAfter(0);
  const result = h.controller.interruptPendingStatusForQualification().then(() => "interrupted", () => "cancelled");
  await h.advance(100);
  const before = h.received.length;
  // Act
  await h.controller.close();
  // Assert
  expect(await result).toBe("cancelled");
  expect(h.received.slice(before)).toEqual([]);
  expect(h.counts()).toMatchObject({ closed: 1, locked: false, active: false });
});

test("an already delivered status returns explicit no-interruption and keeps ownership", async () => {
  // Arrange
  const h = await interruptionHarness();
  await h.controller.requestPermission();
  const nativeHeld = h.holdNativeStatusAfter(1);
  // Act
  const interrupting = h.controller.interruptPendingStatusForQualification();
  await nativeHeld;
  await h.advance(100);
  h.releaseNativeWrite();
  const receipt = await interrupting;
  // Assert
  expect(receipt).toEqual({ schema: "worker-read-interruption-v1", interrupted: false, request_consumed: true, response_pending: false, ownership_released: false });
  expect(h.counts()).toMatchObject({ closed: 0, locked: true, active: false });
  expect((await h.controller.status()).state).toBe("baseline");
  await h.controller.close();
});
