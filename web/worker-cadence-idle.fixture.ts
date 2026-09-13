import { serialHarness } from "./worker-serial.test-support";
import { workerSerialTestRuntime, type WorkerSerialPort } from "./webserial-worker-port";
import { createWebSerialWorkerController, workerSerialQualificationHook, type WorkerSerialQualificationHook } from "./webserial-worker-controller";

/** Delay native settlement of a real credited frame without bypassing the production channel. */
export async function cadenceIdleFixture() {
  const h = await serialHarness(); const runtime = h.input[workerSerialTestRuntime].runtime;
  const port = await runtime.serial.requestPort({ filters: [h.input.deviceFilter] });
  let maybeReadable: WorkerSerialPort["readable"] = null, maybeWritable: WorkerSerialPort["writable"] = null;
  let maybeWriter: WritableStreamDefaultWriter<Uint8Array> | undefined;
  let maybeHoldKind: "heartbeat" | "partial_control" | undefined;
  let maybeRelease: ((complete: boolean) => void) | undefined;
  let held = false, advanceAfterPossession = false;
  runtime.serial.requestPort = async () => ({
    getInfo: () => port.getInfo(), get readable() { return maybeReadable; }, get writable() { return maybeWritable; },
    async open(options) {
      await port.open(options);
      if (!port.readable || !port.writable) throw new Error("fixture_stream_missing");
      maybeReadable = port.readable; maybeWriter = port.writable.getWriter(); const writer = maybeWriter;
      maybeWritable = new WritableStream({
        async write(bytes: Uint8Array) {
          const prefix = new TextDecoder().decode(bytes);
          const heartbeat = maybeHoldKind === "heartbeat" && prefix.includes('"kind":"heartbeat"');
          const partial = maybeHoldKind === "partial_control" && prefix.includes('"kind":"control"');
          if (!heartbeat && !partial) {
            await writer.write(bytes);
            if (advanceAfterPossession && prefix.includes('"command":"prove_possession"')) {
              advanceAfterPossession = false; await h.advance(1000);
            }
            return;
          }
          maybeHoldKind = undefined;
          await writer.write(partial ? bytes.subarray(0, 64) : bytes);
          const release = new Promise<boolean>(resolve => { maybeRelease = resolve; }); held = true;
          const complete = await release;
          if (partial && complete) await writer.write(bytes.subarray(64));
        },
        async abort() { await writer.abort(); },
      });
    },
    async close() { maybeWriter?.releaseLock(); await port.close(); maybeReadable = null; maybeWritable = null; },
  });
  const failures: string[] = [];
  const hook: WorkerSerialQualificationHook = { suppressHeartbeats: false, maybeObserveSerialFailure: category => failures.push(category) };
  const input = { ...h.input, [workerSerialQualificationHook]: hook };
  const controller = createWebSerialWorkerController(input);
  return { h, controller, failures, held: () => held,
    holdHeartbeat() { maybeHoldKind = "heartbeat"; held = false; },
    holdHeartbeatAfterPossession() { maybeHoldKind = "heartbeat"; held = false; advanceAfterPossession = true; },
    holdPartialControl() { maybeHoldKind = "partial_control"; held = false; },
    release(complete = true) { const release = maybeRelease; maybeRelease = undefined; if (!release) throw new Error("fixture_not_held"); release(complete); },
  };
}
