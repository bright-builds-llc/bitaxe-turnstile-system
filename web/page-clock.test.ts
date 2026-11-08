import { expect, test } from "bun:test";
import { createPageClock, type ClockPort, type ClockRequest, type FallbackTimers } from "./page-clock";

function fakePort() {
  const posted: ClockRequest[] = [];
  let tick: (id: unknown) => void = () => undefined;
  let fail: () => void = () => undefined;
  let terminated = false;
  const port: ClockPort = {
    post: (request) => posted.push(request),
    listen: (onTick, onError) => {
      tick = onTick;
      fail = onError;
    },
    terminate: () => {
      terminated = true;
    },
  };
  return { port, posted, tick: (id: number) => tick(id), fail: () => fail(), terminated: () => terminated };
}

function fakeTimers() {
  const intervals = new Map<number, { listener: () => void; milliseconds: number }>();
  const timeouts = new Map<number, { listener: () => void; milliseconds: number }>();
  let next = 0;
  const timers: FallbackTimers = {
    setInterval: (listener, milliseconds) => (intervals.set(++next, { listener, milliseconds }), next),
    clearInterval: (handle) => intervals.delete(handle as number),
    setTimeout: (listener, milliseconds) => (timeouts.set(++next, { listener, milliseconds }), next),
    clearTimeout: (handle) => timeouts.delete(handle as number),
  };
  return { timers, intervals, timeouts };
}

test("every repeats on Worker ticks until cancelled", () => {
  // Arrange
  const worker = fakePort();
  const clock = createPageClock(fakeTimers().timers, worker.port);
  let calls = 0;
  const cancel = clock.every(100, () => calls++);
  // Act
  worker.tick(1);
  worker.tick(1);
  cancel();
  worker.tick(1);
  // Assert
  expect(calls).toBe(2);
  expect(worker.posted).toEqual([{ op: "every", id: 1, milliseconds: 100 }, { op: "cancel", id: 1 }]);
});

test("after fires once however often the Worker reports it", () => {
  // Arrange
  const worker = fakePort();
  const clock = createPageClock(fakeTimers().timers, worker.port);
  let calls = 0;
  clock.after(2000, () => calls++);
  // Act
  worker.tick(1);
  worker.tick(1);
  // Assert
  expect(calls).toBe(1);
});

test("without a Worker the page's own timers carry the schedules", () => {
  // Arrange
  const fallback = fakeTimers();
  const clock = createPageClock(fallback.timers);
  let calls = 0;
  // Act
  clock.every(1000, () => calls++);
  for (const { listener } of fallback.intervals.values()) listener();
  // Assert
  expect([...fallback.intervals.values()].map(({ milliseconds }) => milliseconds)).toEqual([1000]);
  expect(calls).toBe(1);
});

test("a failed Worker moves live schedules onto the page's own timers", () => {
  // Arrange
  const worker = fakePort();
  const fallback = fakeTimers();
  const clock = createPageClock(fallback.timers, worker.port);
  clock.every(100, () => undefined);
  clock.after(2000, () => undefined);
  // Act
  worker.fail();
  // Assert
  expect(worker.terminated()).toBeTrue();
  expect([...fallback.intervals.values()].map(({ milliseconds }) => milliseconds)).toEqual([100]);
  expect([...fallback.timeouts.values()].map(({ milliseconds }) => milliseconds)).toEqual([2000]);
});
