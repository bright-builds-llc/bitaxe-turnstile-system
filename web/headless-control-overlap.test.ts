import { expect, test } from "bun:test";

import fixtures from "../conformance/bwg-worker-controller-0.4/fixtures.json";
import headlessFixtures from "../conformance/bwg-0.1/headless-work-consent-vectors.json";
import { createHeadlessClient, type HeadlessClient, type LifecycleEvent } from "./headless-client";
import { headlessInput, transportHarness } from "./headless-client.test-support";
import { recordingWorkerController } from "./headless-worker-controller.test-support";
import type { PageClock } from "./page-clock";
import { lifecycleView } from "./work-gate-view-model";
import type { WorkerController, WorkerLeaseGrant, WorkerLeaseRenewal } from "./worker-controller";
import { renewWorkerLeaseWhileRunning, type RenewalOutcome } from "./worker-lease-renewal";

type HeldOperation = "startLease" | "pause";

// A real board serves one command at a time: its Start and its stop take tens of seconds on the
// 205 and the 601, and a second command meanwhile fails with `operation_active`.
function slowController(calls: string[], held: ReadonlySet<HeldOperation>) {
  const recording = recordingWorkerController(calls);
  let busy = false;
  const releases: Array<() => void> = [];
  const exclusive = async <T>(operation: string, run: () => Promise<T>): Promise<T> => {
    if (busy) {
      calls.push(`refused:${operation}`);
      throw new Error("Worker Serial operation_active");
    }
    busy = true;
    try {
      if (held.has(operation as HeldOperation)) {
        await new Promise<void>((resolve) => releases.push(resolve));
      }
      return await run();
    } finally {
      busy = false;
    }
  };
  const controller: WorkerController = {
    ...recording,
    startLease: (grant) => exclusive("startLease", () => recording.startLease(grant)),
    renewLease: (renewal) => exclusive("renewLease", () => recording.renewLease(renewal)),
    pause: () => exclusive("pause", () => recording.pause()),
    cancel: () => exclusive("cancel", () => recording.cancel()),
    restore: (reason) => exclusive("restore", () => recording.restore(reason)),
  };
  return {
    controller,
    release: async () => {
      releases.shift()?.();
      await settle();
    },
  };
}

function manualClock() {
  let maybeTick: (() => void) | undefined;
  const clock: PageClock = {
    every: (_milliseconds, listener) => {
      maybeTick = listener;
      return () => (maybeTick = undefined);
    },
    after: () => () => undefined,
  };
  return {
    clock,
    tick: async () => {
      maybeTick?.();
      await settle();
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const grant = () => ({
  ...(fixtures.lease as WorkerLeaseGrant),
  challengeId: headlessFixtures.challenge.challengeId,
});

async function consentedClient(controller: WorkerController) {
  const authority = transportHarness();
  const transport = {
    ...authority.transport,
    start: async () => grant(),
    resume: async () => grant(),
    renewWorkerLease: async () => fixtures.renewal as WorkerLeaseRenewal,
  };
  const client = await createHeadlessClient({
    ...(await headlessInput(transport)),
    maybeWorkerController: controller,
  });
  await client.grantConsent();
  let lifecycle: LifecycleEvent | undefined;
  client.subscribe((event) => {
    if (event.type === "lifecycle") lifecycle = event;
  });
  return { authority, client, lifecycle: () => lifecycle };
}

function renewing(client: HeadlessClient, clock: PageClock) {
  const outcomes: RenewalOutcome[] = [];
  renewWorkerLeaseWhileRunning({
    client,
    maybeClock: clock,
    maybeOnOutcome: (outcome) => outcomes.push(outcome),
  });
  return outcomes;
}

test("a Renew tick during a slow Pause sends no Renew to the stopping board", async () => {
  // Arrange
  const calls: string[] = [];
  const slow = slowController(calls, new Set(["pause"]));
  const { client } = await consentedClient(slow.controller);
  await client.start();
  const time = manualClock();
  renewing(client, time.clock);

  // Act
  const pausing = client.pause();
  await time.tick();
  await slow.release();
  await pausing;

  // Assert
  expect(calls.filter((call) => call !== "discover")).toEqual(["start", "pause"]);
});

test("renewals continue after Resume when a Renew tick fell during a slow Pause", async () => {
  // Arrange
  const calls: string[] = [];
  const slow = slowController(calls, new Set(["pause"]));
  const { client } = await consentedClient(slow.controller);
  await client.start();
  const time = manualClock();
  const outcomes = renewing(client, time.clock);
  const pausing = client.pause();
  await time.tick();
  await slow.release();
  await pausing;

  // Act
  await client.resume();
  await time.tick();
  await time.tick();

  // Assert
  expect(calls.slice(calls.lastIndexOf("start"))).toEqual(["start", "renew", "renew"]);
  expect(outcomes).toEqual([{ type: "renewed" }, { type: "renewed" }]);
});

test("Pause while the board's Start is in flight is refused before it reaches the board", async () => {
  // Arrange
  const calls: string[] = [];
  const slow = slowController(calls, new Set(["startLease"]));
  const { authority, client } = await consentedClient(slow.controller);
  const starting = client.start();
  await settle();
  await authority.emitAuthority({ type: "challenge_lifecycle", state: "active" });

  // Act
  const pause = client.pause();

  // Assert
  await expect(pause).rejects.toThrow("lifecycle transition is forbidden");
  await slow.release();
  await starting;
  expect(calls).not.toContain("pause");
  expect(calls).not.toContain("restore:control_failed");
});

test("the page offers no Pause until the board's Start has completed", async () => {
  // Arrange
  const slow = slowController([], new Set(["startLease"]));
  const { authority, client, lifecycle } = await consentedClient(slow.controller);

  // Act
  const starting = client.start();
  await settle();
  await authority.emitAuthority({ type: "challenge_lifecycle", state: "active" });
  const whileStarting = lifecycleView(lifecycle()!).primaryAction;
  await slow.release();
  await starting;

  // Assert
  expect(whileStarting).toBe("none");
  expect(lifecycleView(lifecycle()!).primaryAction).toBe("pause");
});

test("a failed Start leaves the work paused rather than running", async () => {
  // Arrange
  const controller: WorkerController = {
    ...recordingWorkerController([]),
    startLease: async () => {
      throw new Error("Worker Serial operation_active");
    },
  };
  const { authority, client, lifecycle } = await consentedClient(controller);

  // Act
  const failure = client.start().then(() => undefined, (error: unknown) => error);
  await settle();
  await authority.emitAuthority({ type: "challenge_lifecycle", state: "active" });

  // Assert
  expect(await failure).toBeInstanceOf(Error);
  expect(lifecycle()).toEqual({ type: "lifecycle", challengeState: "active", controlState: "paused" });
});

test("a refused Renew leaves the work paused rather than running", async () => {
  // Arrange
  const controller: WorkerController = {
    ...recordingWorkerController([]),
    renewLease: async () => {
      throw new Error("lease_expired");
    },
  };
  const { client, lifecycle } = await consentedClient(controller);
  await client.start();

  // Act
  await expect(client.renewWorkerLease()).rejects.toThrow("lease_expired");

  // Assert
  expect(lifecycle()).toEqual({ type: "lifecycle", challengeState: "active", controlState: "paused" });
});
