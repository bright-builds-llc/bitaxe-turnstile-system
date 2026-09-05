import { expect, test } from "bun:test";
import { serialHarness } from "./worker-serial.test-support";
import {
  createWebSerialWorkerController,
  workerSerialQualificationHook,
} from "./webserial-worker-controller";

test("production serial admission binds capability, possession, baseline, and max-size probe", async () => {
  // Arrange
  const h = await serialHarness();
  // Act
  const connection = await h.controller.requestPermission();
  const probe = await h.controller.transportProbe();
  // Assert
  expect(connection.status).toBe("ready");
  expect(Math.max(probe.requestPayloadBytes, probe.responsePayloadBytes)).toBe(
    65536,
  );
  expect(h.received.some((frame) => frame.kind === "heartbeat")).toBeTrue();
  await h.controller.close();
  expect(h.counts()).toMatchObject({ closed: 1, locked: false });
});
test("actual signed Start and Renew compose through the admitted current serial session", async () => {
  // Arrange
  const h = await serialHarness();
  await h.controller.requestPermission();
  const grant = await h.grant(
    await h.controller.prepareWorkerLeaseAuthorizationContext("start"),
  );
  // Act
  const started = await h.controller.startLease(grant);
  await h.advance(1000);
  const renewed = await h.controller.renewLease(
    await h.renewal(
      await h.controller.prepareWorkerLeaseAuthorizationContext("renew"),
    ),
  );
  // Assert
  expect(started.state).toBe("mining");
  expect(renewed.state).toBe("mining");
  await expect(h.controller.transportProbe()).rejects.toThrow();
  expect((await h.controller.pause()).restoration).toEqual({
    status: "confirmed",
    reason: "paused",
  });
  await h.controller.close();
});
test("foreground loss stops heartbeats, releases ownership, and cannot automatically resume", async () => {
  // Arrange
  const h = await serialHarness();
  await h.controller.requestPermission();
  // Act
  await h.hide();
  const heartbeats = h.received.filter(
    (frame) => frame.kind === "heartbeat",
  ).length;
  await h.advance(3000);
  h.show();
  // Assert
  await expect(h.controller.status()).rejects.toThrow();
  expect(h.counts()).toMatchObject({ closed: 1, locked: false });
  expect(h.received.filter((frame) => frame.kind === "heartbeat").length).toBe(
    heartbeats,
  );
  expect((await h.controller.requestPermission()).recovered).toBeTrue();
  expect(h.counts().opened).toBe(2);
  await h.controller.close();
});
test("a missed peer heartbeat closes the session while an unrelated Start response is pending", async () => {
  // Arrange
  const h = await serialHarness();
  await h.controller.requestPermission();
  const grant = await h.grant(
    await h.controller.prepareWorkerLeaseAuthorizationContext("start"),
  );
  h.holdStart();
  h.dropHeartbeats();
  const start = h.controller.startLease(grant).then(
    () => "unexpected",
    () => "rejected",
  );
  // Act
  await h.advance(2800);
  // Assert
  expect(await start).toBe("rejected");
  await expect(h.controller.status()).rejects.toThrow();
});
test("one origin cannot acquire a second active Worker port owner", async () => {
  // Arrange
  const h = await serialHarness();
  await h.controller.requestPermission();
  const other = createWebSerialWorkerController(h.input);
  // Act / Assert
  await expect(other.requestPermission()).rejects.toThrow();
  expect(h.counts().opened).toBe(1);
  await h.controller.close();
});

test("qualification challenge activation starts only after human permission resolves", async () => {
  // Arrange
  const h = await serialHarness();
  h.delayPermission();
  let activations = 0;
  const input = {
    ...h.input,
    [workerSerialQualificationHook]: {
      suppressHeartbeats: false,
      async prepareScope() {
        activations++;
        return h.input.continuityScope;
      },
    },
  };
  const controller = createWebSerialWorkerController(input);
  const connecting = controller.requestPermission();
  // Act
  h.jumpWhileUnconnected(86_400_000);
  await Promise.resolve();
  // Assert
  expect(activations).toBe(0);
  expect(h.counts().opened).toBe(0);
  h.grantPermission();
  await connecting;
  expect(activations).toBe(1);
  await controller.close();
});

test("graceful cooling keeps heartbeats but hiding aborts that wait and releases the port", async () => {
  // Arrange
  const h = await serialHarness();
  await h.controller.requestPermission();
  await h.controller.startLease(
    await h.grant(
      await h.controller.prepareWorkerLeaseAuthorizationContext("start"),
    ),
  );
  h.holdRestore();
  const closing = h.controller.close().then(
    () => "confirmed",
    () => "unconfirmed",
  );
  const initial = h.received.filter(
    (frame) => frame.kind === "heartbeat",
  ).length;
  // Act
  await h.advance(4000);
  // Assert
  expect(
    h.received.filter((frame) => frame.kind === "heartbeat").length,
  ).toBeGreaterThan(initial);
  await h.hide();
  expect(await closing).toBe("unconfirmed");
  expect(h.counts()).toMatchObject({ closed: 1, locked: false });
});
