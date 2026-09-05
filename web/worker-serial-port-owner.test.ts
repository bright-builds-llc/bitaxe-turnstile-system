import { expect, test } from "bun:test";
import { WorkerSerialPortOwner } from "./worker-serial-port-owner";
import type { WorkerSerialPort } from "./webserial-worker-port";

function fixture() {
  let finishOpen: () => void = () => { throw new Error("open not initialized"); };
  const opening = new Promise<void>(resolve => { finishOpen = resolve; });
  let closed = 0, released = false, now = 0;
  const timers = new Set<{ at: number; call: () => void }>();
  const port: WorkerSerialPort = {
    readable: null, writable: null, getInfo: () => ({}), open: () => opening,
    async close() { closed++; },
  };
  const owner = new WorkerSerialPortOwner(() => { released = true; }, (ms, call) => {
    const timer = { at: now + ms, call }; timers.add(timer); return () => { timers.delete(timer); };
  });
  return {
    owner, port, finishOpen, counts: () => ({ closed, released }),
    async tick(ms: number) { now += ms; for (const timer of timers) if (now >= timer.at) { timers.delete(timer); timer.call(); } await new Promise(resolve => setTimeout(resolve, 0)); }
  };
}

test("timed-out open keeps ownership until the late-opened port is closed", async () => {
  // Arrange
  const f = fixture();
  const opened = f.owner.open(f.port).then(() => "opened", () => "timed_out");
  // Act
  await f.tick(2000);
  expect(await opened).toBe("timed_out");
  const cleanup = f.owner.close().then(() => "closed", () => "pending");
  await f.tick(2000);
  // Assert
  expect(await cleanup).toBe("pending");
  expect(f.counts()).toEqual({ closed: 0, released: false });
  f.finishOpen(); await f.tick(0);
  expect(f.counts()).toEqual({ closed: 1, released: true });
  expect(f.owner.released).toBeTrue();
});

test("failed close does not falsely release origin ownership", async () => {
  // Arrange
  const f = fixture(); f.port.close = async () => { throw new Error("fixture close failure"); };
  const opened = f.owner.open(f.port); f.finishOpen(); await opened;
  // Act / Assert
  await expect(f.owner.close()).rejects.toThrow();
  expect(f.owner.released).toBeFalse();
  expect(f.counts().released).toBeFalse();
});

test("cancellation before opening prevents a later native open", async () => {
  // Arrange
  const f = fixture();
  // Act
  await f.owner.close();
  // Assert
  await expect(f.owner.open(f.port)).rejects.toThrow();
  expect(f.counts()).toEqual({ closed: 0, released: true });
});

test("late native channel closure releases ownership after the bounded caller has returned", async () => {
  // Arrange
  const { WorkerSerialChannel } = await import("./webserial-worker-port");
  let finishClose: () => void = () => { throw new Error("close not pending"); };
  const port: WorkerSerialPort = {
    getInfo: () => ({}),
    readable: new ReadableStream<Uint8Array>(),
    writable: new WritableStream<Uint8Array>(),
    async open() { },
    close: () => new Promise<void>(resolve => { finishClose = resolve; }),
  };
  let released = false;
  const owner = new WorkerSerialPortOwner(() => { released = true; }, undefined);
  await owner.open(port);
  owner.attach(new WorkerSerialChannel(port, () => { }, () => { }));
  // Act
  const closing = owner.close().then(() => "closed", () => "pending");
  await new Promise(resolve => setTimeout(resolve, 2100));
  // Assert
  expect(await closing).toBe("pending");
  expect(released).toBeFalse();
  finishClose();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(released).toBeTrue();
  expect(owner.released).toBeTrue();
});
