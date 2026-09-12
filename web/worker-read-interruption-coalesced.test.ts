import { expect, spyOn, test } from "bun:test";
import { serialHarness } from "./worker-serial.test-support";
import { createWebSerialWorkerController, workerSerialQualificationHook } from "./webserial-worker-controller";
import { workerSerialTestRuntime, type WorkerSerialPort } from "./webserial-worker-port";

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test("a consumed pending response may already be completely delivered to the browser reader", async () => {
  // Arrange
  const h = await serialHarness();
  const runtime = h.input[workerSerialTestRuntime].runtime;
  const port = await runtime.serial.requestPort({ filters: [h.input.deviceFilter] });
  const delivered = deferred(), hashing = deferred(), closing = deferred(), resumeHash = deferred();
  let armed = false, precedingStatus = 1, fullReplyDelivered = false, hashHeld = false;
  let completeReplyBytes = 0, coalescedChunkBytes = 0, nativeWrites = 0;
  let maybeTargetChunk: Uint8Array | undefined, maybeTargetPayload: string | undefined;
  let maybeCredit: Uint8Array | undefined;
  let maybeReadable: ReadableStream<Uint8Array> | null = null;
  let maybeWritable: WritableStream<Uint8Array> | null = null;
  let maybeWriter: WritableStreamDefaultWriter<Uint8Array> | undefined;

  const nativeRead = ReadableStreamDefaultReader.prototype.read;
  const readSpy = spyOn(ReadableStreamDefaultReader.prototype, "read").mockImplementation(async function (this: ReadableStreamDefaultReader<Uint8Array>): Promise<{ done: true; value: undefined } | { done: false; value: Uint8Array }> {
      const result = await nativeRead.call(this);
      if (!result.done && result.value === maybeTargetChunk) {
        fullReplyDelivered = true;
        delivered.release();
      }
      return result.done ? { done: true as const, value: undefined } : { done: false as const, value: result.value };
  });
  const nativeDigest = crypto.subtle.digest.bind(crypto.subtle);
  const digestSpy = spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, input) => {
    const bytes = ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input);
    const target = fullReplyDelivered && new TextDecoder().decode(bytes) === maybeTargetPayload;
    if (target) { hashHeld = true; hashing.release(); await resumeHash.promise; }
    return nativeDigest(algorithm, input);
  });

  const owned: WorkerSerialPort = {
    getInfo: () => port.getInfo(),
    get readable() { return maybeReadable; }, get writable() { return maybeWritable; },
    async open(options) {
      await port.open(options);
      if (!port.readable || !port.writable) throw new Error("fixture_stream_missing");
      maybeWriter = port.writable.getWriter();
      const writer = maybeWriter;
      maybeWritable = new WritableStream({
        async write(bytes) { nativeWrites += 1; await writer.write(bytes); },
        async abort() { closing.release(); await writer.abort(); },
      });
      let buffered: number[] = [];
      maybeReadable = port.readable.pipeThrough(new TransformStream({
        transform(bytes, output) {
          for (const byte of bytes) {
            buffered.push(byte);
            if (byte !== 10) continue;
            const wire = Uint8Array.from(buffered); buffered = [];
            const frame = JSON.parse(new TextDecoder().decode(wire));
            if (armed && frame.kind === "session" && frame.payload.op === "receive_credit") {
              if (maybeCredit) throw new Error("unexpected_second_credit");
              maybeCredit = wire;
              continue;
            }
            if (armed && maybeCredit && frame.kind === "control" && frame.payload.result?.state) {
              const combined = Uint8Array.from([...maybeCredit, ...wire]);
              maybeCredit = undefined;
              if (precedingStatus-- === 0) {
                maybeTargetChunk = combined;
                maybeTargetPayload = JSON.stringify(frame.payload);
                completeReplyBytes = wire.length;
                coalescedChunkBytes = combined.length;
                armed = false;
              }
              output.enqueue(combined);
              continue;
            }
            if (maybeCredit) { output.enqueue(maybeCredit); maybeCredit = undefined; }
            output.enqueue(wire);
          }
        },
      }));
    },
    async close() { maybeWriter?.releaseLock(); await port.close(); maybeReadable = null; maybeWritable = null; },
  };
  runtime.serial.requestPort = async () => owned;
  const input = { ...h.input, [workerSerialQualificationHook]: { suppressHeartbeats: false } };
  const controller = createWebSerialWorkerController(input);
  try {
    await controller.requestPermission();
    armed = true;
    const before = h.received.length;
    // Act
    const interrupting = controller.interruptPendingStatusForQualification();
    await Promise.all([delivered.promise, hashing.promise, closing.promise]);
    // Assert
    expect(fullReplyDelivered).toBeTrue();
    expect(hashHeld).toBeTrue();
    resumeHash.release();
    const receipt = await interrupting;
    const writesAtClose = nativeWrites;
    await h.advance(3000);
    expect(receipt).toMatchObject({ schema: "worker-read-interruption-v2", interrupted: true, request_consumed: true, response_promise_pending: true, ownership_released: true, host_observation: { validationPending: true } });
    expect(Object.hasOwn(receipt, "response_pending")).toBeFalse();
    expect(h.received.slice(before)).toEqual([{ kind: "control", command: "status" }, { kind: "control", command: "status" }]);
    expect(nativeWrites).toBe(writesAtClose);
    expect(h.counts()).toMatchObject({ closed: 1, locked: false, active: false });
    const trace = controller.exportBrowserSerialTrace();
    const validating = [...trace.events].reverse().find(event => event.stage === "validation_started");
    if (!validating) throw new Error("missing_validation_event");
    const frameEvents = trace.events.filter(event => event.epoch === validating.epoch && event.frameOrdinal === validating.frameOrdinal);
    expect(frameEvents.map(event => event.stage)).toEqual(["frame_assembled", "validation_started", "validation_completed", "frame_suppressed"]);
    const closeStarted = [...trace.events].reverse().find(event => event.stage === "close_started");
    expect(closeStarted?.ordinal).toBeGreaterThan(validating.ordinal);
    expect([...trace.events].reverse().find(event => event.stage === "validation_completed")?.ordinal).toBeGreaterThan(closeStarted?.ordinal ?? 0);
    expect(coalescedChunkBytes).toBeGreaterThan(completeReplyBytes);
    expect(trace.events.some(event => event.stage === "chunk_received" && event.wireBytes === coalescedChunkBytes)).toBeTrue();
    await controller.requestPermission();
    const reconnected = controller.exportBrowserSerialTrace();
    expect(reconnected.events.some(event => event.epoch === validating.epoch && event.stage === "frame_suppressed")).toBeTrue();
    expect(reconnected.events.some(event => event.epoch > validating.epoch && event.stage === "epoch_started")).toBeTrue();
  } finally {
    resumeHash.release();
    readSpy.mockRestore();
    digestSpy.mockRestore();
    await controller.close();
  }
}, 5000);
