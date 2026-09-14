import { expect, test } from "bun:test";
import { WorkerSerialRestart } from "./worker-serial-restart";
import { WorkerSerialPortOwner } from "./worker-serial-port-owner";
import { WorkerSerialChannel, type WorkerSerialPort } from "./webserial-worker-port";
const request = { requestNonce: "A".repeat(22), expectedBootOrdinal: 1 };

test("expired prearm budget prevents even the preparation callback from starting", async () => {
  // Arrange
  const owner = new WorkerSerialRestart(); let now = 0, preparation = 0, resets = 0, cleanup = 0;
  // Act / Assert
  await expect(owner.run(request, {
    ready() {}, identity: () => ({ sessionId: "A".repeat(22), hostNonce: "A".repeat(43), deviceNonce: "A".repeat(43), firmwareSourceCommit: "a".repeat(40), appElfSha256: "b".repeat(64) }),
    now: () => now, maybeAfter: undefined, prearm: () => { now = 30000; },
    prepare: async () => { preparation++; }, freezeWrites: async () => {}, request: async () => { resets++; },
    acknowledged() {}, reopen: async () => {}, fresh: async () => {}, finish() {}, cleanup: async () => { cleanup++; },
  })).rejects.toThrow();
  expect(preparation).toBe(0); expect(resets).toBe(0); expect(cleanup).toBe(1);
});

test("cancellation while old port closure is pending cannot reopen after releasing the WebLock", async () => {
  // Arrange
  let opened = 0, released = 0, closing = false;
  let finishClose: () => void = () => { throw new Error("close not pending"); };
  const port: WorkerSerialPort = { readable: new ReadableStream(), writable: new WritableStream(), getInfo: () => ({}),
    open: async () => { opened++; }, close: async () => { closing = true; await new Promise<void>(resolve => { finishClose = resolve; }); } };
  const owner = new WorkerSerialPortOwner(() => { released++; }, undefined); await owner.open(port);
  owner.attach(new WorkerSerialChannel(port, () => {}, () => {}));
  const reopened = owner.reopenExpectedReset(() => {}).then(() => "opened", () => "cancelled");
  while (!closing) await new Promise(resolve => setTimeout(resolve, 0));
  // Act
  const cancelled = owner.close(); finishClose(); await cancelled;
  // Assert
  expect(await reopened).toBe("cancelled"); expect(opened).toBe(1); expect(released).toBe(1); expect(owner.released).toBeTrue();
});

test("a decoder callback error cannot masquerade as a native stream end and authorize reopening", async () => {
  const { WorkerSerialRestartObserver } = await import("./worker-serial-restart-observer");
  const { encodeWorkerSerialEnvelope, WORKER_SERIAL_PROFILE } = await import("./worker-serial");
  const observer = new WorkerSerialRestartObserver(request, { firmwareSourceCommit: "a".repeat(40), appElfSha256: "b".repeat(64) }, () => 0, "f".repeat(64));
  observer.acknowledge({ schema: "worker-qualification-restart-v1", requestNonce: request.requestNonce, bootOrdinal: 1, nextBootOrdinal: 2 }); observer.helloStarted();
  const frame = await encodeWorkerSerialEnvelope({ profile: WORKER_SERIAL_PROFILE, kind: "heartbeat", sessionId: "A".repeat(22), sequence: 1, payload: {} });
  let failed: () => void = () => { throw new Error("not installed"); }; const failure = new Promise<void>(resolve => { failed = resolve; });
  const port: WorkerSerialPort = { readable: new ReadableStream({ start(output) { output.enqueue(frame); } }), writable: new WritableStream(), getInfo: () => ({}), open: async () => {}, close: async () => {} };
  const channel = new WorkerSerialChannel(port, () => { throw new Error("synthetic callback failure"); }, () => failed()); channel.observeExpectedRestart(observer);
  await failure; expect(observer.summary().streamInterrupted).toBeFalse(); await channel.close();
});
