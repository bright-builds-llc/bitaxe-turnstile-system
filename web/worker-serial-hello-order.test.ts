import { expect, test } from "bun:test";
import { serialHarness } from "./worker-serial.test-support";
import { workerSerialTestRuntime } from "./webserial-worker-port";
import { WORKER_SERIAL_PROFILE, parseWorkerSerialEnvelope, encodeWorkerSerialEnvelope, type WorkerSerialEnvelope } from "./worker-serial";
import { createWebSerialWorkerController, workerSerialQualificationHook, type WorkerSerialQualificationHook } from "./webserial-worker-controller";
import type { WorkerSerialDiagnostic } from "./worker-serial-diagnostics";

async function reorderedHello(mode: "stale_credit" | "current_records" | "excess_credit", holdNativeHello = false) {
  const h = await serialHarness();
  const runtime = h.input[workerSerialTestRuntime].runtime;
  const port = await runtime.serial.requestPort({ filters: [h.input.deviceFilter] });
  let maybeReadable: ReadableStream<Uint8Array> | null = null;
  let maybeWritable: WritableStream<Uint8Array> | null = null;
  let maybeWriter: WritableStreamDefaultWriter<Uint8Array> | undefined;
  let first = true, firstWrite = true, helloWriteSettled = false, ackBeforeWriteSettlement = false;
  let offset = 0;
  const buffered: number[] = [];
  runtime.serial.requestPort = async () => ({
    getInfo: () => port.getInfo(), get readable() { return maybeReadable; }, get writable() { return maybeWritable; },
    async open(options) {
      await port.open(options);
      if (!port.readable || !port.writable) throw new Error("fixture_stream_missing");
      maybeWriter = port.writable.getWriter();
      const writer = maybeWriter;
      maybeWritable = new WritableStream({
        async write(bytes) {
          const hello = firstWrite; firstWrite = false;
          await writer.write(bytes);
          if (hello) {
            if (holdNativeHello) await new Promise(resolve => setTimeout(resolve, 25));
            helloWriteSettled = true;
          }
        },
        async abort() { await writer.abort(); },
      });
      maybeReadable = port.readable.pipeThrough(new TransformStream({
        async transform(bytes, output) {
          for (const byte of bytes) {
            buffered.push(byte);
            if (byte !== 10) continue;
            const frame = parseWorkerSerialEnvelope(JSON.parse(new TextDecoder().decode(Uint8Array.from(buffered.splice(0)))));
            if (!first) { output.enqueue(await encodeWorkerSerialEnvelope({ ...frame, sequence: frame.sequence + offset })); continue; }
            first = false;
            const extra: WorkerSerialEnvelope[] = mode === "current_records" ? [
              { profile: WORKER_SERIAL_PROFILE, kind: "heartbeat", sessionId: frame.sessionId, sequence: 1, payload: {} },
              { profile: WORKER_SERIAL_PROFILE, kind: "diagnostic", sessionId: frame.sessionId, sequence: 2, payload: { line: "usb_memory_checkpoint stage=usb_install free_bytes=4000 largest_block_bytes=3000 reserve_bytes=1000 redacted=true" } },
            ] : [{ profile: WORKER_SERIAL_PROFILE, kind: "session", sessionId: mode === "stale_credit" ? "AAAAAAAAAAAAAAAAAAAAAA" : frame.sessionId, sequence: 1, payload: { op: "receive_credit", receivedBytes: 1024 } }];
            offset = extra.length;
            const all = [await encodeWorkerSerialEnvelope(frame), ...await Promise.all(extra.map(encodeWorkerSerialEnvelope))];
            ackBeforeWriteSettlement = !helloWriteSettled;
            output.enqueue(Uint8Array.from(all.flatMap(chunk => [...chunk])));
          }
        },
      }));
    },
    async close() { maybeWriter?.releaseLock(); await port.close(); maybeReadable = null; maybeWritable = null; },
  });
  const diagnostics: WorkerSerialDiagnostic[] = [];
  const hook: WorkerSerialQualificationHook = { suppressHeartbeats: false, maybeObserveDiagnostic: value => diagnostics.push(value) };
  const input = { ...h.input, [workerSerialQualificationHook]: hook };
  return { h: { ...h, controller: createWebSerialWorkerController(input) }, diagnostics, ackBeforeWriteSettlement: () => ackBeforeWriteSettlement };
}

test.each(["stale_credit", "excess_credit"] as const)("fresh Hello followed by %s in the same read is rejected", async mode => {
  // Arrange
  const { h } = await reorderedHello(mode);
  // Act / Assert
  const rejected = await h.controller.requestPermission().then(() => false, () => true);
  await h.controller.close();
  expect(rejected).toBeTrue();
  expect(h.counts()).toMatchObject({ closed: 1, locked: false });
});

test("current-session heartbeat and diagnostic after Hello in the same read are processed", async () => {
  // Arrange
  const { h, diagnostics } = await reorderedHello("current_records");
  // Act
  const admission = await h.controller.requestPermission();
  const probe = await h.controller.transportProbe();
  await h.controller.close();
  // Assert
  expect(admission.status).toBe("ready");
  expect(probe.requestPayloadBytes).toBe(65536);
  expect(diagnostics).toEqual([{ category: "memory", authoritative: false, stage: "usb_install", free_bytes: 4000, largest_block_bytes: 3000, reserve_bytes: 1000 }]);
});

test("early Hello acknowledgement does not turn the pending native Hello write into credited bytes", async () => {
  // Arrange
  const fixture = await reorderedHello("current_records", true);
  // Act
  await fixture.h.controller.requestPermission();
  const probe = await fixture.h.controller.transportProbe();
  await fixture.h.controller.close();
  // Assert
  expect(fixture.ackBeforeWriteSettlement()).toBeTrue();
  expect(probe.requestPayloadBytes).toBe(65536);
  expect(fixture.h.counts()).toMatchObject({ closed: 1, locked: false });
});
