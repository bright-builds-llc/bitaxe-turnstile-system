import { expect, test } from "bun:test";
import { cadenceIdleFixture } from "./worker-cadence-idle.fixture";

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
test("cadence review waits for a normal heartbeat write instead of rejecting healthy idle", async () => {
  // Arrange
  const f = await cadenceIdleFixture(); await f.controller.requestPermission();
  f.holdHeartbeat(); await f.h.advance(1000); expect(f.held()).toBeTrue();
  let outcome = "pending";
  const review = f.controller.telemetryCadenceReview().then(value => { outcome = "passed"; return value; }, error => { outcome = "rejected"; throw error; });
  const observed = review.catch(error => error);
  try {
    // Act
    await settle(); const beforeRelease = outcome; f.release();
    const result = await observed;
    // Assert
    expect(beforeRelease).toBe("pending");
    expect(result.schema).toBe("worker-telemetry-cadence-v1");
    expect(outcome).toBe("passed");
    expect(f.h.counts()).toMatchObject({ opened: 1, closed: 0, active: false });
  } finally { await f.controller.close(); }
});


test("a heartbeat queued after fresh possession cannot reject the second idle guard", async () => {
  // Arrange
  const f = await cadenceIdleFixture(); await f.controller.requestPermission();
  f.holdHeartbeatAfterPossession(); let outcome = "pending";
  const review = f.controller.telemetryCadenceReview().then(value => { outcome = "passed"; return value; }, error => { outcome = "rejected"; throw error; });
  const observed = review.catch(error => error);
  try {
    // Act
    for (let count = 0; count < 100 && !f.held(); count++) await settle();
    expect(f.held()).toBeTrue(); await settle(); const beforeRelease = outcome; f.release();
    const result = await observed;
    // Assert
    expect(beforeRelease).toBe("pending"); expect(result.schema).toBe("worker-telemetry-cadence-v1");
    expect(outcome).toBe("passed"); expect(f.h.counts().opened).toBe(1);
  } finally { await f.controller.close(); }
});

test("a cancelled partial control still requires an explicit fresh serial session", async () => {
  // Arrange
  const f = await cadenceIdleFixture(); await f.controller.requestPermission(); f.holdPartialControl();
  const probe = f.controller.transportProbe().then(() => false, () => true);
  for (let count = 0; count < 100 && !f.held(); count++) await settle();
  expect(f.held()).toBeTrue(); const before = f.h.received.length;
  // Act / Assert
  await expect(f.controller.telemetryCadenceReview()).rejects.toMatchObject({ category: "probe_admission" });
  expect(f.h.received.length).toBe(before);
  const closed = f.controller.close(); f.release(false); await closed;
  expect(await probe).toBeTrue(); await expect(f.controller.telemetryCadenceReview()).rejects.toThrow();
  expect(f.h.counts()).toMatchObject({ opened: 1, closed: 1, locked: false });
  await f.controller.requestPermission();
  try {
    expect((await f.controller.telemetryCadenceReview()).schema).toBe("worker-telemetry-cadence-v1");
    expect(f.h.counts().opened).toBe(2);
  } finally { await f.controller.close(); }
});

test("a heartbeat that never settles retains the existing whole-record timeout", async () => {
  // Arrange
  const f = await cadenceIdleFixture(); await f.controller.requestPermission(); f.holdHeartbeat(); await f.h.advance(1000);
  expect(f.held()).toBeTrue(); const before = f.h.received.length;
  // Act / Assert
  try {
    await expect(f.controller.telemetryCadenceReview()).rejects.toMatchObject({ category: "possession_failed" });
    expect(f.failures[0]).toBe("timeout");
    expect(f.h.received.slice(before).some(value => value.command === "telemetry_cadence_review")).toBeFalse();
  } finally { f.release(); await f.controller.close(); }
  await expect(f.controller.telemetryCadenceReview()).rejects.toThrow();
  expect(f.h.counts()).toMatchObject({ opened: 1, closed: 1, locked: false });
});

test("review refreshes possession after a complete sixty-second idle interval", async () => {
  // Arrange
  const f = await cadenceIdleFixture(); await f.controller.requestPermission(); await f.h.advance(61000);
  const before = f.h.received.filter(value => value.command === "prove_possession").length;
  // Act
  const review = await f.controller.telemetryCadenceReview();
  // Assert
  expect(review.schema).toBe("worker-telemetry-cadence-v1");
  expect(f.h.received.filter(value => value.command === "prove_possession").length).toBe(before + 1);
  await f.controller.close();
});
