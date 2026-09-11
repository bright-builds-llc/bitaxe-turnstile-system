import { serialHarness } from "./worker-serial.test-support";
import { createWebSerialWorkerController, workerSerialQualificationHook } from "./webserial-worker-controller";
import { workerSerialTestRuntime, type WorkerSerialPort } from "./webserial-worker-port";

/** Delays actual fixture response bytes while forwarding its normal receive credits. */
export async function interruptionHarness(withHook = true) {
  const h = await serialHarness();
  const runtime = h.input[workerSerialTestRuntime].runtime;
  const port = await runtime.serial.requestPort({ filters: [h.input.deviceFilter] });
  let maybeReadable: ReadableStream<Uint8Array> | null = null;
  let maybeWritable: WritableStream<Uint8Array> | null = null;
  let maybeWriter: WritableStreamDefaultWriter<Uint8Array> | undefined;
  let statusesUntilHold = -1, heldReplies = 0, credits = 0, writes = 0;
  let statusesUntilNativeHold = -1;
  let maybeReleaseNative: (() => void) | undefined;
  let maybeNativeHeld: (() => void) | undefined;
  let maybeHeld: Uint8Array | undefined;
  let maybeOutput: TransformStreamDefaultController<Uint8Array> | undefined;
  const owned: WorkerSerialPort = {
    getInfo: () => port.getInfo(),
    get readable() { return maybeReadable; }, get writable() { return maybeWritable; },
    async open(options) {
      await port.open(options);
      if (!port.readable || !port.writable) throw new Error("fixture_stream_missing");
      maybeWriter = port.writable.getWriter();
      const writer = maybeWriter;
      maybeWritable = new WritableStream({
        async write(bytes) {
          writes += 1;
          const before = h.received.length;
          await writer.write(bytes);
          const statusReceived = h.received.slice(before).some(frame => frame.command === "status");
          if (statusReceived && statusesUntilNativeHold >= 0 && statusesUntilNativeHold-- === 0) {
            const held = new Promise<void>(resolve => { maybeReleaseNative = resolve; });
            maybeNativeHeld?.();
            await held;
          }
        },
        async abort() { await writer.abort(); },
      });
      let buffered: number[] = [];
      maybeReadable = port.readable.pipeThrough(new TransformStream({
        transform(bytes, output) {
          maybeOutput = output;
          for (const byte of bytes) {
            buffered.push(byte);
            if (byte !== 10) continue;
            const wire = Uint8Array.from(buffered);
            buffered = [];
            const frame = JSON.parse(new TextDecoder().decode(wire));
            if (frame.kind === "session" && frame.payload.op === "receive_credit") credits += 1;
            if (frame.kind === "control" && frame.payload.result?.state && statusesUntilHold >= 0 && statusesUntilHold-- === 0) {
              maybeHeld = wire;
              heldReplies += 1;
            } else output.enqueue(wire);
          }
        },
      }));
    },
    async close() { maybeWriter?.releaseLock(); await port.close(); maybeReadable = null; maybeWritable = null; },
  };
  runtime.serial.requestPort = async () => owned;
  const input = withHook ? { ...h.input, [workerSerialQualificationHook]: { suppressHeartbeats: false } } : h.input;
  return {
    ...h, controller: createWebSerialWorkerController(input),
    holdStatusAfter(preceding: number) { statusesUntilHold = preceding; },
    holdNativeStatusAfter(preceding: number) {
      statusesUntilNativeHold = preceding;
      return new Promise<void>(resolve => { maybeNativeHeld = resolve; });
    },
    releaseNativeWrite() { maybeReleaseNative?.(); },
    releaseReply() {
      if (!maybeHeld || !maybeOutput) throw new Error("fixture_reply_missing");
      maybeOutput.enqueue(maybeHeld);
      maybeHeld = undefined;
    },
    wireCounts: () => ({ heldReplies, credits, writes }),
  };
}
