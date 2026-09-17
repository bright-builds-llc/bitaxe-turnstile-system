import { expect, test } from "bun:test";
import { maybeInvokeWorkerConnectGesture, WORKER_QUALIFICATION_GESTURE_NOTICE, type WorkerConnectGesture } from "./worker-qualification-gesture";

const valid: WorkerConnectGesture = { qualification: true, trusted: true, visible: true, focused: true, active: true };
for (const predicate of ["trusted", "visible", "focused", "active"] as const) {
  test(`qualification rejects missing ${predicate} before permission or controller effects`, () => {
    // Arrange.
    const effects = { connect: 0, stateChanges: 0, permission: 0, lock: 0 }, notices: string[] = [];
    const connect = async () => { effects.connect++; effects.stateChanges++; effects.permission++; effects.lock++; };
    // Act.
    const result = maybeInvokeWorkerConnectGesture({ ...valid, [predicate]: false }, connect, value => notices.push(value));
    // Assert.
    expect(result).toBeUndefined();
    expect(effects).toEqual({ connect: 0, stateChanges: 0, permission: 0, lock: 0 });
    expect(notices).toEqual([WORKER_QUALIFICATION_GESTURE_NOTICE]);
  });
}

test("accepted qualification invokes Connect synchronously before the next microtask", async () => {
  // Arrange.
  const order: string[] = [];
  const connection = Promise.resolve("connected");
  queueMicrotask(() => order.push("microtask"));
  // Act.
  const result = maybeInvokeWorkerConnectGesture(valid, () => { order.push("connect"); return connection; }, value => order.push(`notice:${value}`));
  // Assert.
  expect(result).toBe(connection); expect(order).toEqual(["notice:", "connect"]);
  await result; expect(order).toEqual(["notice:", "connect", "microtask"]);
});

test("ordinary Connect retains prior asynchronous scheduling and does not add qualification checks", async () => {
  // Arrange.
  let calls = 0; const notices: string[] = [];
  // Act.
  const result = maybeInvokeWorkerConnectGesture({ qualification: false, trusted: false, visible: false, focused: false, active: false },
    async () => { calls++; }, value => notices.push(value));
  // Assert.
  expect(calls).toBe(0); await result; expect(calls).toBe(1); expect(notices).toEqual([]);
});

test("failed precondition does not consume the next genuine Connect gesture", async () => {
  // Arrange.
  let calls = 0; const notices: string[] = [], connect = async () => { calls++; };
  // Act.
  maybeInvokeWorkerConnectGesture({ ...valid, focused: false }, connect, value => notices.push(value));
  await maybeInvokeWorkerConnectGesture(valid, connect, value => notices.push(value));
  // Assert.
  expect(calls).toBe(1); expect(notices).toEqual([WORKER_QUALIFICATION_GESTURE_NOTICE, ""]);
});

test("real Connect rejection remains a failure for the existing UI handler", async () => {
  // Arrange.
  const cause = new Error("synthetic admission rejection");
  // Act.
  const result = maybeInvokeWorkerConnectGesture(valid, () => Promise.reject(cause), () => {});
  // Assert.
  await expect(result).rejects.toBe(cause);
});
