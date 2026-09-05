import { expect, test } from "bun:test";

import fixtures from "../conformance/bwg-worker-controller-0.4/fixtures.json";
import headlessFixtures from "../conformance/bwg-0.1/headless-work-consent-vectors.json";
import { createHeadlessClient } from "./headless-client";
import { headlessInput, transportHarness } from "./headless-client.test-support";
import type {
  WorkerController,
  WorkerControllerCapabilities,
  WorkerControllerDisconnectReason,
  WorkerLeaseGrant,
  WorkerLeaseRenewal,
} from "./worker-controller";
import { recordingWorkerController } from "./headless-worker-controller.test-support";

const workerLease = {
  ...(fixtures.lease as WorkerLeaseGrant),
  challengeId: headlessFixtures.challenge.challengeId,
};

test("headless client drives only the public Worker Controller interface", async () => {
  // Arrange
  const calls: string[] = [];
  const controller = recordingWorkerController(calls);
  const authority = transportHarness();
  const renewal = fixtures.renewal as WorkerLeaseRenewal;
  const transport = {
    ...authority.transport,
    async start() {
      authority.calls.push("start");
      return workerLease;
    },
    async resume() {
      authority.calls.push("resume");
      return workerLease;
    },
    async renewWorkerLease() {
      return renewal;
    },
  };
  const client = await createHeadlessClient({
    ...(await headlessInput(transport)),
    maybeWorkerController: controller,
  });
  await client.grantConsent();

  // Act
  await client.start();
  await client.renewWorkerLease();
  await client.pause();
  await client.resume();
  await client.cancel();

  // Assert
  expect(client.maybeWorkerCapabilities()).toEqual(
    fixtures.capabilities as WorkerControllerCapabilities,
  );
  expect(calls).toEqual(["discover", "start", "renew", "pause", "start", "cancel"]);
  expect(authority.calls).toEqual(["start", "pause", "resume", "cancel"]);
});

test("headless client obtains the possession context before Authority Start", async () => {
  // Arrange
  const ordering: string[] = [];
  const controller = recordingWorkerController(ordering);
  const authority = transportHarness();
  const expectedContext = { controlSessionBindingSha256: "S".repeat(43) };
  const transport = {
    ...authority.transport,
    async start(_maybeReceipt?: string, maybeContext?: unknown) {
      ordering.push("authority:start");
      expect(maybeContext).toEqual(expectedContext);
      return workerLease;
    },
  };
  const client = await createHeadlessClient({
    ...(await headlessInput(transport)),
    maybeWorkerController: controller,
    maybeWorkerLeaseAuthorizationContext: {
      async prepareWorkerLeaseAuthorizationContext(operation: "start" | "renew") {
        ordering.push(`context:${operation}`);
        return expectedContext;
      },
    },
  });
  await client.grantConsent();
  ordering.length = 0;

  // Act
  await client.start();

  // Assert
  expect(ordering).toEqual(["context:start", "authority:start", "start"]);
});

test("headless client binds renewal and resume to their current authorization contexts", async () => {
  // Arrange
  const operations: string[] = [];
  const controller = recordingWorkerController([]);
  const authority = transportHarness();
  const transport = {
    ...authority.transport,
    async start(_receipt?: string, context?: { controlSessionBindingSha256: string }) {
      operations.push(`authority:start:${String(context?.controlSessionBindingSha256)}`);
      return workerLease;
    },
    async renewWorkerLease(context?: { controlSessionBindingSha256: string }) {
      operations.push(`authority:renew:${String(context?.controlSessionBindingSha256)}`);
      return fixtures.renewal as WorkerLeaseRenewal;
    },
    async resume(context?: { controlSessionBindingSha256: string }) {
      operations.push(`authority:resume:${String(context?.controlSessionBindingSha256)}`);
      return workerLease;
    },
  };
  let sequence = 0;
  const client = await createHeadlessClient({
    ...(await headlessInput(transport)),
    maybeWorkerController: controller,
    maybeWorkerLeaseAuthorizationContext: {
      async prepareWorkerLeaseAuthorizationContext(operation) {
        operations.push(`context:${operation}`);
        sequence += 1;
        return { controlSessionBindingSha256: String(sequence).padStart(43, "S") };
      },
    },
  });
  await client.grantConsent();

  // Act
  await client.start();
  await client.renewWorkerLease();
  await client.pause();
  await client.resume();

  // Assert
  expect(operations).toEqual([
    "context:start",
    `authority:start:${String(1).padStart(43, "S")}`,
    "context:renew",
    `authority:renew:${String(2).padStart(43, "S")}`,
    "context:start",
    `authority:resume:${String(3).padStart(43, "S")}`,
  ]);
});

test("terminal Authority state restores the Worker before client completion", async () => {
  // Arrange
  const calls: string[] = [];
  const controller = recordingWorkerController(calls);
  const authority = transportHarness();
  const transport = {
    ...authority.transport,
    async start() {
      authority.calls.push("start");
      return workerLease;
    },
  };
  const client = await createHeadlessClient({
    ...(await headlessInput(transport)),
    maybeWorkerController: controller,
  });
  await client.grantConsent();
  await client.start();

  // Act
  await authority.emitAuthority({ type: "challenge_lifecycle", state: "satisfied" });

  // Assert
  expect(calls).toEqual(["discover", "start", "restore:challenge_satisfied"]);
});

test("controller admission failure pauses the Authority lease", async () => {
  // Arrange
  const calls: string[] = [];
  const controller = {
    ...recordingWorkerController(calls),
    async startLease() {
      calls.push("start_rejected");
      throw new Error("device rejected Work Lease");
    },
  } satisfies WorkerController;
  const authority = transportHarness();
  const transport = {
    ...authority.transport,
    async start() {
      authority.calls.push("start");
      return workerLease;
    },
  };
  const client = await createHeadlessClient({
    ...(await headlessInput(transport)),
    maybeWorkerController: controller,
  });
  await client.grantConsent();

  // Act
  const start = client.start();

  // Assert
  await expect(start).rejects.toThrow("device rejected Work Lease");
  expect(authority.calls).toEqual(["start", "pause"]);
  expect(calls).toEqual(["discover", "start_rejected", "restore:control_failed"]);
});

test("wrong-challenge Worker Lease is restored and paused", async () => {
  // Arrange
  const calls: string[] = [];
  const controller = recordingWorkerController(calls);
  const authority = transportHarness();
  const transport = {
    ...authority.transport,
    async start() {
      authority.calls.push("start");
      return { ...workerLease, challengeId: "challenge_wrong_01" };
    },
  };
  const client = await createHeadlessClient({
    ...(await headlessInput(transport)),
    maybeWorkerController: controller,
  });
  await client.grantConsent();

  // Act
  const start = client.start();

  // Assert
  await expect(start).rejects.toThrow("does not match the active Work Challenge");
  expect(calls).toEqual(["discover", "restore:control_failed"]);
  expect(authority.calls).toEqual(["start", "pause"]);
});

test("renewal failure restores the Worker and pauses the Authority", async () => {
  // Arrange
  const calls: string[] = [];
  const controller = {
    ...recordingWorkerController(calls),
    async renewLease() {
      calls.push("renew_rejected");
      throw new Error("device rejected renewal");
    },
  } satisfies WorkerController;
  const authority = transportHarness();
  const transport = {
    ...authority.transport,
    async start() {
      authority.calls.push("start");
      return workerLease;
    },
    async renewWorkerLease() {
      return fixtures.renewal as WorkerLeaseRenewal;
    },
  };
  const client = await createHeadlessClient({
    ...(await headlessInput(transport)),
    maybeWorkerController: controller,
  });
  await client.grantConsent();
  await client.start();

  // Act
  const renew = client.renewWorkerLease();

  // Assert
  await expect(renew).rejects.toThrow("device rejected renewal");
  expect(authority.calls).toEqual(["start", "pause"]);
  expect(calls.at(-1)).toBe("restore:control_failed");
});

test("Authority renewal failure restores the Worker and pauses the lease", async () => {
  // Arrange
  const calls: string[] = [];
  const controller = recordingWorkerController(calls);
  const authority = transportHarness();
  const transport = {
    ...authority.transport,
    async start() {
      authority.calls.push("start");
      return workerLease;
    },
    async renewWorkerLease(): Promise<WorkerLeaseRenewal> {
      throw new Error("Authority renewal failed");
    },
  };
  const client = await createHeadlessClient({
    ...(await headlessInput(transport)),
    maybeWorkerController: controller,
  });
  await client.grantConsent();
  await client.start();

  // Act
  const renew = client.renewWorkerLease();

  // Assert
  await expect(renew).rejects.toThrow("Authority renewal failed");
  expect(calls.at(-1)).toBe("restore:control_failed");
  expect(authority.calls).toEqual(["start", "pause"]);
});

test("wrong-challenge renewal status restores and pauses", async () => {
  // Arrange
  const calls: string[] = [];
  const controller = {
    ...recordingWorkerController(calls),
    async renewLease() {
      calls.push("renew_wrong_challenge");
      return {
        protocolVersion: "bwg-worker-controller/0.4" as const,
        state: "mining" as const,
        monotonicMilliseconds: 1,
        lease: {
          leaseId: workerLease.leaseId,
          challengeId: "challenge_wrong_renewal_01",
          renewAtMonotonicMilliseconds: 20_001,
          expiresAtMonotonicMilliseconds: 60_001,
        },
        restoration: { status: "pending" as const },
      };
    },
  } satisfies WorkerController;
  const authority = transportHarness();
  const transport = {
    ...authority.transport,
    async start() {
      authority.calls.push("start");
      return workerLease;
    },
    async renewWorkerLease() {
      return fixtures.renewal as WorkerLeaseRenewal;
    },
  };
  const client = await createHeadlessClient({
    ...(await headlessInput(transport)),
    maybeWorkerController: controller,
  });
  await client.grantConsent();
  await client.start();

  // Act
  const renew = client.renewWorkerLease();

  // Assert
  await expect(renew).rejects.toThrow("expected Work Lease");
  expect(calls.at(-1)).toBe("restore:control_failed");
  expect(authority.calls).toEqual(["start", "pause"]);
});

test("tab closure restores the Worker and pauses the Authority", async () => {
  // Arrange
  const calls: string[] = [];
  const controller = recordingWorkerController(calls);
  const authority = transportHarness();
  const transport = {
    ...authority.transport,
    async start() {
      authority.calls.push("start");
      return workerLease;
    },
  };
  const client = await createHeadlessClient({
    ...(await headlessInput(transport)),
    maybeWorkerController: controller,
  });
  await client.grantConsent();
  await client.start();

  // Act
  await client.close();

  // Assert
  expect(calls.at(-1)).toBe("restore:tab_closed");
  expect(authority.calls).toEqual(["start", "pause"]);
});

test("controller disconnect pauses the Authority through the public hook", async () => {
  // Arrange
  let maybeDisconnect: ((reason: WorkerControllerDisconnectReason) => Promise<void>) | undefined;
  const controller = {
    ...recordingWorkerController([]),
    subscribeDisconnect(listener) {
      maybeDisconnect = listener;
      return () => {
        maybeDisconnect = undefined;
      };
    },
  } satisfies WorkerController;
  const authority = transportHarness();
  const transport = {
    ...authority.transport,
    async start() {
      authority.calls.push("start");
      return workerLease;
    },
  };
  const client = await createHeadlessClient({
    ...(await headlessInput(transport)),
    maybeWorkerController: controller,
  });
  await client.grantConsent();
  await client.start();

  // Act
  await maybeDisconnect?.("connectivity_lost");

  // Assert
  expect(authority.calls).toEqual(["start", "pause"]);
});

test("admission rollback preserves controller and Authority failures", async () => {
  // Arrange
  const controller = {
    ...recordingWorkerController([]),
    async startLease() {
      throw new Error("admission failed");
    },
    async restore() {
      throw new Error("restoration failed");
    },
  } satisfies WorkerController;
  const authority = transportHarness();
  const transport = {
    ...authority.transport,
    async start() {
      return workerLease;
    },
    async pause() {
      throw new Error("Authority pause failed");
    },
  };
  const client = await createHeadlessClient({
    ...(await headlessInput(transport)),
    maybeWorkerController: controller,
  });
  await client.grantConsent();

  // Act
  let maybeError: unknown;
  try {
    await client.start();
  } catch (error) {
    maybeError = error;
  }

  // Assert
  expect(maybeError).toBeInstanceOf(AggregateError);
  const messages = (maybeError as AggregateError).errors.map((error) => String(error));
  expect(messages).toEqual([
    "Error: admission failed",
    "Error: restoration failed",
    "Error: Authority pause failed",
  ]);
});
