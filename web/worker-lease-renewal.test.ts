import { expect, test } from "bun:test";

import type { HeadlessEvent, LifecycleEvent } from "./headless-client.types";
import type { PageClock } from "./page-clock";
import {
  renewWorkerLeaseWhileRunning,
  WORKER_LEASE_RENEWAL_MILLISECONDS,
  type RenewalOutcome,
} from "./worker-lease-renewal";

const running: LifecycleEvent = { type: "lifecycle", challengeState: "active", controlState: "running" };
const paused: LifecycleEvent = { type: "lifecycle", challengeState: "active", controlState: "paused" };

function manualClock() {
  const schedules = new Map<number, () => void>();
  const periods: number[] = [];
  let next = 0;
  const clock: PageClock = {
    every(milliseconds, listener) {
      const id = ++next;
      periods.push(milliseconds);
      schedules.set(id, listener);
      return () => schedules.delete(id);
    },
    after() {
      throw new Error("Renew schedules no one-shot timers");
    },
  };
  return {
    clock,
    periods,
    armed: () => schedules.size,
    async tick() {
      for (const listener of schedules.values()) listener();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

function fakeClient(initial: LifecycleEvent, renew: () => Promise<void> = async () => undefined) {
  const listeners = new Set<(event: HeadlessEvent) => void>();
  let renewals = 0;
  return {
    client: {
      subscribe(listener: (event: HeadlessEvent) => void) {
        listeners.add(listener);
        listener(initial);
        return () => listeners.delete(listener);
      },
      renewWorkerLease() {
        renewals += 1;
        return renew();
      },
    },
    emit: (event: HeadlessEvent) => listeners.forEach((listener) => listener(event)),
    renewals: () => renewals,
    subscribed: () => listeners.size,
  };
}

function start(client: ReturnType<typeof fakeClient>["client"], clock: PageClock) {
  const outcomes: RenewalOutcome[] = [];
  const stop = renewWorkerLeaseWhileRunning({
    client,
    maybeClock: clock,
    maybeOnOutcome: (outcome) => outcomes.push(outcome),
  });
  return { outcomes, stop };
}

test("Renew runs on the Authority's 20 s healthy-continuity cadence", () => {
  // Arrange
  const time = manualClock();

  // Act
  start(fakeClient(running).client, time.clock);

  // Assert
  expect(time.periods).toEqual([WORKER_LEASE_RENEWAL_MILLISECONDS]);
  expect(WORKER_LEASE_RENEWAL_MILLISECONDS).toBe(20_000);
});

test("each tick while work runs renews the Worker Lease and reports it", async () => {
  // Arrange
  const time = manualClock();
  const fake = fakeClient(running);
  const { outcomes } = start(fake.client, time.clock);

  // Act
  await time.tick();
  await time.tick();

  // Assert
  expect(fake.renewals()).toBe(2);
  expect(outcomes).toEqual([{ type: "renewed" }, { type: "renewed" }]);
});

test("a paused session skips Renew and renews again once resumed", async () => {
  // Arrange
  const time = manualClock();
  const fake = fakeClient(paused);
  start(fake.client, time.clock);

  // Act
  await time.tick();
  fake.emit(running);
  await time.tick();

  // Assert
  expect(fake.renewals()).toBe(1);
});

test("a refusal is reported and does not end Renew", async () => {
  // Arrange
  const time = manualClock();
  let refusals = 0;
  const fake = fakeClient(running, async () => {
    refusals += 1;
    if (refusals === 1) throw new Error("Work Session renew failed: 409");
  });
  const { outcomes } = start(fake.client, time.clock);

  // Act
  await time.tick();
  await time.tick();

  // Assert
  expect(outcomes).toEqual([
    { type: "refused", message: "Work Session renew failed: 409" },
    { type: "renewed" },
  ]);
});

test("Renew skips while a Pause is in flight", async () => {
  // Arrange
  const time = manualClock();
  const fake = fakeClient(running);
  start(fake.client, time.clock);

  // Act
  fake.emit({ type: "lifecycle", challengeState: "active", controlState: "pausing" });
  await time.tick();

  // Assert
  expect(fake.renewals()).toBe(0);
});

test("the Authority's terminal report ends Renew before the terminal lifecycle is exposed", async () => {
  // Arrange
  const time = manualClock();
  const fake = fakeClient(running);
  const { outcomes } = start(fake.client, time.clock);

  // Act
  fake.emit({ type: "terminal_reported", challengeState: "satisfied" });
  await time.tick();

  // Assert
  expect(fake.renewals()).toBe(0);
  expect(outcomes).toEqual([]);
  expect(time.armed()).toBe(0);
});

test("a refusal racing the Authority's terminal report is not reported", async () => {
  // Arrange
  const time = manualClock();
  let refuse: ((error: Error) => void) | undefined;
  const fake = fakeClient(running, () => new Promise((_, reject) => (refuse = reject)));
  const { outcomes } = start(fake.client, time.clock);
  await time.tick();

  // Act
  fake.emit({ type: "terminal_reported", challengeState: "pass_issued" });
  refuse?.(new Error("lifecycle transition is forbidden"));
  await time.tick();

  // Assert
  expect(outcomes).toEqual([]);
});

test("a terminal lifecycle ends Renew", async () => {
  // Arrange
  const time = manualClock();
  const fake = fakeClient(running);
  start(fake.client, time.clock);

  // Act
  fake.emit({ type: "lifecycle", challengeState: "cancelled", controlState: "cancelled" });
  await time.tick();

  // Assert
  expect(fake.renewals()).toBe(0);
  expect(time.armed()).toBe(0);
});

test("a session that is already terminal never arms Renew", () => {
  // Arrange
  const time = manualClock();
  const fake = fakeClient({ type: "lifecycle", challengeState: "expired", controlState: "expired" });

  // Act
  start(fake.client, time.clock);

  // Assert
  expect(time.armed()).toBe(0);
  expect(fake.subscribed()).toBe(0);
});

test("a tick while a Renew is still in flight sends no second Renew", async () => {
  // Arrange
  const time = manualClock();
  const fake = fakeClient(running, () => new Promise(() => undefined));
  start(fake.client, time.clock);

  // Act
  await time.tick();
  await time.tick();

  // Assert
  expect(fake.renewals()).toBe(1);
});

test("stopping Renew cancels its ticks and its subscription", async () => {
  // Arrange
  const time = manualClock();
  const fake = fakeClient(running);
  const { stop } = start(fake.client, time.clock);

  // Act
  stop();
  await time.tick();

  // Assert
  expect(fake.renewals()).toBe(0);
  expect(time.armed()).toBe(0);
  expect(fake.subscribed()).toBe(0);
});
