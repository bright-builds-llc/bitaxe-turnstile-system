import { expect, test } from "bun:test";

import fixtures from "../conformance/bwg-worker-controller-0.4/fixtures.json";
import headlessFixtures from "../conformance/bwg-0.1/headless-work-consent-vectors.json";
import { createHeadlessClient, type HeadlessEvent } from "./headless-client";
import type { PageClock } from "./page-clock";
import { renewWorkerLeaseWhileRunning, type RenewalOutcome } from "./worker-lease-renewal";
import { headlessInput, transportHarness } from "./headless-client.test-support";
import { recordingWorkerController } from "./headless-worker-controller.test-support";
import type {
  WorkerController,
  WorkerControllerStatus,
  WorkerLeaseGrant,
  WorkerLeaseRenewal,
} from "./worker-controller";

// A real Controller confirms restoration only after the device's stop and cooling, which can take
// longer than 30 s, and it fails its session if a second command arrives meanwhile.
function slowRestoringController(calls: string[]) {
  const recording = recordingWorkerController(calls);
  let pending = false;
  let finishRestore: (() => void) | undefined;
  let failRestore: ((error: Error) => void) | undefined;
  const exclusive = async <T>(run: () => Promise<T>): Promise<T> => {
    if (pending) throw new Error("operation_active");
    return run();
  };
  const controller: WorkerController = {
    ...recording,
    renewLease: (renewal) => exclusive(() => recording.renewLease(renewal)),
    pause: () => exclusive(() => recording.pause()),
    restore: (reason) =>
      exclusive(async () => {
        pending = true;
        await new Promise<void>((resolve, reject) => {
          finishRestore = resolve;
          failRestore = reject;
        });
        pending = false;
        return recording.restore(reason) as Promise<WorkerControllerStatus>;
      }),
  };
  return {
    controller,
    finish: () => finishRestore?.(),
    fail: (error: Error) => failRestore?.(error),
  };
}

async function miningClient(
  controller: WorkerController,
  renewAuthorityLease: () => Promise<WorkerLeaseRenewal> = async () => fixtures.renewal as WorkerLeaseRenewal,
) {
  const authority = transportHarness();
  const transport = {
    ...authority.transport,
    async start() {
      return { ...(fixtures.lease as WorkerLeaseGrant), challengeId: headlessFixtures.challenge.challengeId };
    },
    renewWorkerLease: renewAuthorityLease,
  };
  const client = await createHeadlessClient({ ...(await headlessInput(transport)), maybeWorkerController: controller });
  await client.grantConsent();
  await client.start();
  const states: string[] = [];
  client.subscribe((event: HeadlessEvent) => {
    if (event.type === "lifecycle") states.push(event.challengeState);
  });
  return { authority, client, states };
}

test("satisfied and pass_issued during a slow restore share one restoration", async () => {
  // Arrange
  const calls: string[] = [];
  const slow = slowRestoringController(calls);
  const { authority, states } = await miningClient(slow.controller);

  // Act
  const satisfied = authority.emitAuthority({ type: "challenge_lifecycle", state: "satisfied" });
  const passIssued = authority.emitAuthority({ type: "challenge_lifecycle", state: "pass_issued" });
  slow.finish();
  await Promise.all([satisfied, passIssued]);

  // Assert
  expect(calls.filter((call) => call.startsWith("restore"))).toEqual(["restore:challenge_satisfied"]);
  expect(states.at(-1)).toBe("pass_issued");
});

test("a renewal during terminal restoration never reaches the Controller", async () => {
  // Arrange
  const calls: string[] = [];
  const slow = slowRestoringController(calls);
  const { authority, client } = await miningClient(slow.controller);
  const satisfied = authority.emitAuthority({ type: "challenge_lifecycle", state: "satisfied" });

  // Act
  const renewal = client.renewWorkerLease();

  // Assert
  await expect(renewal).rejects.toThrow("lifecycle transition is forbidden");
  slow.finish();
  await satisfied;
  expect(calls).not.toContain("renew");
});

test("a failed restoration still exposes the terminal state and reports the failure", async () => {
  // Arrange
  const calls: string[] = [];
  const slow = slowRestoringController(calls);
  const { authority, states } = await miningClient(slow.controller);

  // Act
  const passIssued = authority.emitAuthority({ type: "challenge_lifecycle", state: "pass_issued" });
  slow.fail(new Error("liveness_lost"));

  // Assert
  await expect(passIssued).rejects.toThrow("liveness_lost");
  expect(states.at(-1)).toBe("pass_issued");
});

test("the Authority's terminal report is emitted before a slow restoration settles", async () => {
  // Arrange
  const slow = slowRestoringController([]);
  const { authority, client } = await miningClient(slow.controller);
  const events: string[] = [];
  client.subscribe((event) => events.push(event.type === "lifecycle" ? event.challengeState : event.type));

  // Act
  const satisfied = authority.emitAuthority({ type: "challenge_lifecycle", state: "satisfied" });

  // Assert
  expect(events.at(-1)).toBe("terminal_reported");
  slow.finish();
  await satisfied;
  expect(events.at(-1)).toBe("satisfied");
});

test("Renew sends nothing and reports nothing during a slow terminal restoration", async () => {
  // Arrange
  const calls: string[] = [];
  const slow = slowRestoringController(calls);
  const { authority, client } = await miningClient(slow.controller);
  let tick: (() => void) | undefined;
  const clock: PageClock = {
    every: (_milliseconds, listener) => {
      tick = listener;
      return () => (tick = undefined);
    },
    after: () => () => undefined,
  };
  const outcomes: RenewalOutcome[] = [];
  renewWorkerLeaseWhileRunning({ client, maybeClock: clock, maybeOnOutcome: (outcome) => outcomes.push(outcome) });
  const satisfied = authority.emitAuthority({ type: "challenge_lifecycle", state: "satisfied" });

  // Act
  tick?.();
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Assert
  expect(outcomes).toEqual([]);
  slow.finish();
  await satisfied;
  expect(calls.slice(calls.indexOf("restore:challenge_satisfied") + 1)).toEqual([]);
});

test("a Renew in flight when terminal restoration begins sends no command after the restore", async () => {
  // Arrange
  const slow = slowRestoringController([]);
  const attempts: string[] = [];
  const controller: WorkerController = {
    ...slow.controller,
    renewLease: (renewal) => (attempts.push("renew"), slow.controller.renewLease(renewal)),
    pause: () => (attempts.push("pause"), slow.controller.pause()),
    restore: (reason) => (attempts.push(`restore:${reason}`), slow.controller.restore(reason)),
  };
  let answerRenew: ((error: Error) => void) | undefined;
  const { authority, client } = await miningClient(
    controller,
    () => new Promise((_, reject) => (answerRenew = reject)),
  );
  const renewal = client.renewWorkerLease();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const satisfied = authority.emitAuthority({ type: "challenge_lifecycle", state: "satisfied" });

  // Act
  answerRenew?.(new Error("Work Session renew failed: 409"));

  // Assert
  await expect(renewal).rejects.toThrow("Work Session renew failed: 409");
  slow.finish();
  await satisfied;
  expect(attempts).toEqual(["restore:challenge_satisfied"]);
});
