import { workerSerialTestRuntime } from "./webserial-worker-port";
import { createMemoryWorkerContinuityAccess } from "./worker-continuity-store";
import {
  restoreAcceptanceBaseline,
  acceptanceWindowShouldStop,
  AcceptanceRenewalProgress,
  requireAcceptanceFaultHeadroom,
} from "./worker-serial-acceptance-actions";
import { expect, test } from "bun:test";
import {
  WorkerPreservationBaseline,
  parseWorkerPreservation,
  type WorkerPreservation,
} from "./worker-preservation";
import { serialHarness } from "./worker-serial.test-support";
import {
  createWebSerialWorkerController,
  workerSerialQualificationHook,
} from "./webserial-worker-controller";
const wire = {
  schema: "worker-preservation-v1",
  settings_sha256: "1".repeat(64),
  authorization_high_water_sha256: "2".repeat(64),
  device_identity_sha256: "3".repeat(64),
  mine_on_boot: false,
};

test("public preservation contains only comparisons and one stable random page baseline", () => {
  // Arrange
  const baseline = new WorkerPreservationBaseline();
  baseline.observe(parseWorkerPreservation(wire));
  const first = baseline.maybePublicState();
  // Act
  baseline.observe(parseWorkerPreservation(wire));
  // Assert
  expect(baseline.maybePublicState()).toEqual(first);
  expect(first?.baseline_id).toMatch(/^[A-Za-z0-9_-]{21}[AQgw]$/u);
  expect(first).toMatchObject({
    settings_match: true,
    authorization_high_water_match: true,
    device_identity_match: true,
    mine_on_boot: false,
  });
  for (const digest of [
    wire.settings_sha256,
    wire.authorization_high_water_sha256,
    wire.device_identity_sha256,
  ])
    expect(JSON.stringify(first)).not.toContain(digest);
});
for (const [field, comparison] of [
  ["settings_sha256", "settings_match"],
  ["authorization_high_water_sha256", "authorization_high_water_match"],
  ["device_identity_sha256", "device_identity_match"],
] as const) {
  test(`changed ${field} cannot reset the private baseline`, () => {
    // Arrange
    const baseline = new WorkerPreservationBaseline();
    baseline.observe(parseWorkerPreservation(wire));
    const id = baseline.maybePublicState()?.baseline_id;
    // Act
    baseline.observe(
      parseWorkerPreservation({ ...wire, [field]: "f".repeat(64) }),
    );
    // Assert
    expect(baseline.maybePublicState()?.[comparison]).toBeFalse();
    expect(baseline.maybePublicState()?.baseline_id).toBe(id);
  });
}
test("a new page cannot inherit the previous comparison lineage", () => {
  // Arrange
  const first = new WorkerPreservationBaseline();
  const next = new WorkerPreservationBaseline();
  // Act
  first.observe(parseWorkerPreservation(wire));
  next.observe(parseWorkerPreservation(wire));
  // Assert
  expect(first.maybePublicState()?.baseline_id).not.toBe(
    next.maybePublicState()?.baseline_id,
  );
});
test("wire preservation rejects unknown fields and noncanonical digests", () => {
  // Arrange / Act / Assert
  expect(() => parseWorkerPreservation({ ...wire, extra: "secret" })).toThrow();
  expect(() =>
    parseWorkerPreservation({ ...wire, settings_sha256: "F".repeat(64) }),
  ).toThrow();
});
test("production serial observer keeps preservation private across reconnect and changed settings", async () => {
  // Arrange
  const h = await serialHarness();
  const baseline = new WorkerPreservationBaseline();
  const input = {
    ...h.input,
    [workerSerialQualificationHook]: {
      suppressHeartbeats: false,
      observePreservation: (value: WorkerPreservation) =>
        baseline.observe(value),
    },
  };
  const controller = createWebSerialWorkerController(input);
  await controller.requestPermission();
  const id = baseline.maybePublicState()?.baseline_id;
  // Act
  const status = await controller.status();
  await controller.close();
  await controller.requestPermission();
  h.alterPreservation("settings_sha256");
  await controller.status();
  // Assert
  expect("preservation" in status).toBeFalse();
  expect(baseline.maybePublicState()?.baseline_id).toBe(id);
  expect(baseline.maybePublicState()?.settings_match).toBeFalse();
  await controller.close();
});
test("device cannot substitute a preservation fingerprint unrelated to its verified possession key", async () => {
  // Arrange
  const h = await serialHarness();
  await h.controller.requestPermission();
  h.alterPreservation("device_identity_sha256");
  // Act / Assert
  await expect(h.controller.status()).rejects.toThrow();
});

test("acceptance window termination requests terminal restoration through the production adapter", async () => {
  // Arrange
  const h = await serialHarness();
  await h.controller.requestPermission();
  await h.controller.startLease(
    await h.grant(
      await h.controller.prepareWorkerLeaseAuthorizationContext("start"),
    ),
  );
  // Act
  const stopped = await restoreAcceptanceBaseline(h.controller);
  // Assert
  expect(stopped.restoration).toEqual({
    status: "confirmed",
    reason: "cancelled",
  });
  expect(h.received.some((frame) => frame.command === "restore")).toBeTrue();
  expect(h.received.some((frame) => frame.command === "pause")).toBeFalse();
  await h.controller.close();
});

test("normal acceptance stops from the device work-gate headroom before the reserved shutdown tail", () => {
  // Act / Assert
  expect(acceptanceWindowShouldStop(0, 180000, 160000, 2000)).toBeTrue();
  expect(acceptanceWindowShouldStop(0, 180000, 160000, 2001)).toBeFalse();
  expect(acceptanceWindowShouldStop(1, 30000, 29999, 2000)).toBeFalse();
  expect(acceptanceWindowShouldStop(0, 180000, 180000, undefined)).toBeTrue();
});

test("renewal evidence counts successful signed acknowledgments and resets for a new window", async () => {
  // Arrange
  const h = await serialHarness();
  await h.controller.requestPermission();
  await h.controller.startLease(
    await h.grant(
      await h.controller.prepareWorkerLeaseAuthorizationContext("start"),
    ),
  );
  const renewal = await h.renewal(
    await h.controller.prepareWorkerLeaseAuthorizationContext("renew"),
  );
  const progress = new AcceptanceRenewalProgress();
  // Act
  await progress.renew(h.controller, renewal);
  // Assert
  expect(progress.confirmed).toBe(1);
  await expect(
    progress.renew(
      {
        async renewLease() {
          throw new Error("unconfirmed");
        },
      },
      renewal,
    ),
  ).rejects.toThrow();
  expect(progress.confirmed).toBe(1);
  progress.beginWindow();
  expect(progress.confirmed).toBe(0);
  await h.controller.close();
});

test("qualification continuity storage is memory-only and does not survive a new page", async () => {
  // Arrange
  const scope = {
    challengeId: "challenge_memory_only",
    retentionExpiryUnixSeconds: Math.floor(Date.now() / 1000) + 60,
  };
  const current = createMemoryWorkerContinuityAccess(scope);
  const next = createMemoryWorkerContinuityAccess(scope);
  // Act
  await current.establish("A".repeat(43));
  // Assert
  expect(await current.maybeExpectedFingerprint()).toBe("A".repeat(43));
  expect(await next.maybeExpectedFingerprint()).toBeUndefined();
});

test("qualification production adapter admits without an IndexedDB continuity dependency", async () => {
  // Arrange
  const h = await serialHarness();
  const input = {
    ...h.input,
    [workerSerialTestRuntime]: {
      runtime: h.input[workerSerialTestRuntime].runtime,
    },
    [workerSerialQualificationHook]: {
      suppressHeartbeats: false,
      memoryOnlyContinuity: true,
    },
  };
  const controller = createWebSerialWorkerController(input);
  // Act
  const admitted = await controller.requestPermission();
  // Assert
  expect(admitted.status).toBe("ready");
  await controller.close();
});

test("planned qualification faults reject exhausted or missing work-gate headroom", () => {
  // Act / Assert
  expect(() => requireAcceptanceFaultHeadroom(3001)).not.toThrow();
  for (const value of [undefined, null, 3000, 0])
    expect(() => requireAcceptanceFaultHeadroom(value)).toThrow();
});

test("device confirmation comes from actual status and is invalidated before effects or ownership loss", async () => {
  // Arrange
  const h = await serialHarness();
  let confirmed = false,
    inactive = false;
  const input = {
    ...h.input,
    [workerSerialQualificationHook]: {
      suppressHeartbeats: false,
      observeStatus: (
        value: import("./worker-controller").WorkerControllerStatus | undefined,
      ) => {
        inactive = value?.state === "baseline";
        confirmed =
          value?.state === "baseline" &&
          value.restoration.status === "confirmed";
      },
    },
  };
  const controller = createWebSerialWorkerController(input);
  await controller.requestPermission();
  expect(inactive).toBeTrue();
  // Act
  await controller.startLease(
    await h.grant(
      await controller.prepareWorkerLeaseAuthorizationContext("start"),
    ),
  );
  // Assert
  expect(confirmed).toBeFalse();
  expect(inactive).toBeFalse();
  await controller.close();
  expect(confirmed).toBeTrue();
  expect(inactive).toBeTrue();
  await controller.requestPermission();
  await h.hide();
  expect(confirmed).toBeFalse();
  expect(inactive).toBeFalse();
});
