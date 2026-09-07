import { expect, test } from "bun:test";
import { serialHarness } from "./worker-serial.test-support";
import { workerSerialTestRuntime } from "./webserial-worker-port";
import { encodeWorkerSerialEnvelope, WORKER_SERIAL_PROFILE, WORKER_SERIAL_MANIFEST, WorkerSerialFramer } from "./worker-serial";

async function fixture(prefix: Uint8Array[]) {
  const h = await serialHarness();
  const runtime = h.input[workerSerialTestRuntime].runtime;
  const port = await runtime.serial.requestPort({ filters: [h.input.deviceFilter] });
  let maybeReadable: ReadableStream<Uint8Array> | null = null;
  runtime.serial.requestPort = async () => ({
    getInfo: () => port.getInfo(),
    get readable() { return maybeReadable; },
    get writable() { return port.writable; },
    async open(options) {
      await port.open(options);
      if (!port.readable) throw new Error("fixture_stream_missing");
      maybeReadable = port.readable.pipeThrough(new TransformStream({
        start(output) { for (const bytes of prefix) output.enqueue(bytes); },
        transform(bytes, output) { output.enqueue(bytes); },
      }));
    },
    async close() { await port.close(); maybeReadable = null; },
  });
  return h;
}
function credit(sequence: number, payload: Record<string, unknown> = { op: "receive_credit", receivedBytes: 1024 }) {
  return encodeWorkerSerialEnvelope({ profile: WORKER_SERIAL_PROFILE, kind: "session", sessionId: "AAAAAAAAAAAAAAAAAAAAAA", sequence, payload });
}

test.each([1, 32])("%s queued old credits do not replace the fresh Hello acknowledgement", async count => {
  // Arrange
  const prefix = await Promise.all(Array.from({ length: count }, (_, index) => credit(index + 1)));
  const h = await fixture(prefix);
  // Act
  const admission = await h.controller.requestPermission();
  const probe = await h.controller.transportProbe();
  await h.controller.close();
  // Assert: old credit neither admits transport nor offsets fresh-session counters.
  expect(admission.status).toBe("ready");
  expect(probe.requestPayloadBytes).toBe(65536);
  expect(h.counts()).toMatchObject({ closed: 1, locked: false });
});

test("the thirty-third pre-Hello credit closes admission", async () => {
  // Arrange
  const h = await fixture(await Promise.all(Array.from({ length: 33 }, (_, index) => credit(index + 1))));
  // Act / Assert
  await expect(h.controller.requestPermission()).rejects.toThrow();
  await h.controller.close();
  expect(h.counts()).toMatchObject({ closed: 1, locked: false });
});

test("one cancelled partial JSON output resynchronizes at LF before fresh Hello", async () => {
  // Arrange
  const prefix = new TextEncoder().encode('{"profile":"bwg-worker-serial/0.2","payload":{"padding":"partial\n');
  const h = await fixture([prefix]);
  // Act
  const admission = await h.controller.requestPermission();
  await h.controller.close();
  // Assert
  expect(admission.status).toBe("ready");
  expect(h.counts()).toMatchObject({ closed: 1, locked: false });
});

test("one partial UTF-8 output resynchronizes at LF before fresh Hello", async () => {
  // Arrange
  const h = await fixture([new Uint8Array([0xe2, 0x82, 10])]);
  // Act
  const admission = await h.controller.requestPermission();
  await h.controller.close();
  // Assert
  expect(admission.status).toBe("ready");
});

test("bootstrap prefix allowance ends at exactly 66560 bytes including LF", async () => {
  // Arrange
  const h = await fixture([new TextEncoder().encode("{" + " ".repeat(66558) + "\n")]);
  // Act
  const admission = await h.controller.requestPermission();
  await h.controller.close();
  // Assert
  expect(admission.status).toBe("ready");
});

test.each(["second_prefix", "oversized"])("%s exceeds the bootstrap prefix allowance", async kind => {
  // Arrange
  const text = kind === "second_prefix" ? "{\n{\n" : "{" + " ".repeat(66559) + "\n";
  const h = await fixture([new TextEncoder().encode(text)]);
  // Act / Assert
  await expect(h.controller.requestPermission()).rejects.toThrow();
  await h.controller.close();
  expect(h.counts()).toMatchObject({ closed: 1, locked: false });
});

test.each(["profile", "fields", "integrity"])("valid JSON with wrong %s is never prefix resynchronization", async kind => {
  // Arrange
  const frame = JSON.parse(new TextDecoder().decode(await credit(1)));
  if (kind === "profile") frame.profile = "bwg-worker-serial/0.1";
  if (kind === "fields") frame.extra = true;
  if (kind === "integrity") frame.payloadSha256 = "A".repeat(43);
  const h = await fixture([new TextEncoder().encode(JSON.stringify(frame) + "\n")]);
  // Act / Assert
  await expect(h.controller.requestPermission()).rejects.toThrow();
  await h.controller.close();
  expect(h.counts()).toMatchObject({ closed: 1, locked: false });
});

test("malformed traffic remains fatal after fresh Hello admission", async () => {
  // Arrange
  const h = await fixture([]);
  await h.controller.requestPermission();
  // Act
  h.receiveRaw(new TextEncoder().encode("{\n"));
  await h.advance(100);
  // Assert
  await expect(h.controller.status()).rejects.toThrow();
  await h.controller.close();
  expect(h.counts()).toMatchObject({ closed: 1, locked: false });
});

test("Hello acknowledgement ends prefix tolerance within the same read batch", async () => {
  // Arrange
  const ack = await encodeWorkerSerialEnvelope({ profile: WORKER_SERIAL_PROFILE, kind: "session", sessionId: "AAAAAAAAAAAAAAAAAAAAAA", sequence: 0, payload: {
    op: "hello_ack", hostNonce: "A".repeat(43), deviceNonce: "A".repeat(43),
    serialManifest: WORKER_SERIAL_MANIFEST, firmwareSourceCommit: "a".repeat(40), appElfSha256: "b".repeat(64), receiveWindowBytes: 2048, receivedBytes: 0,
  } });
  const bytes = new Uint8Array([...ack, ...new TextEncoder().encode("{\n")]);
  // Act / Assert
  await expect(new WorkerSerialFramer(undefined, true).push(bytes)).rejects.toThrow();
});

test("syntactically valid JSON with invalid Unicode is not a truncated prefix", async () => {
  // Arrange
  const bytes = await credit(1, { op: "receive_credit", receivedBytes: 1024, extra: "\ud800" });
  const h = await fixture([bytes]);
  // Act / Assert
  await expect(h.controller.requestPermission()).rejects.toThrow();
  await h.controller.close();
  expect(h.counts()).toMatchObject({ closed: 1, locked: false });
});

test.each([
  { op: "receive_credit", receivedBytes: 0 },
  { op: "receive_credit", receivedBytes: -1 },
  { op: "receive_credit", receivedBytes: 4294967296 },
  { op: "receive_credit", receivedBytes: 1024, extra: "synthetic" },
])("malformed pre-Hello credit is rejected", async payload => {
  // Arrange
  const h = await fixture([await credit(1, payload)]);
  // Act / Assert
  await expect(h.controller.requestPermission()).rejects.toThrow();
  await h.controller.close();
  expect(h.counts()).toMatchObject({ closed: 1, locked: false });
});
