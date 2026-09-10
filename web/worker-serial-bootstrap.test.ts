import { createWebSerialWorkerController, workerSerialQualificationHook, type WorkerSerialQualificationHook } from "./webserial-worker-controller";
import { expect, test } from "bun:test";
import { serialHarness } from "./worker-serial.test-support";
import { workerSerialTestRuntime } from "./webserial-worker-port";
import { encodeWorkerSerialEnvelope, WORKER_SERIAL_PROFILE, WORKER_SERIAL_MANIFEST, WorkerSerialFramer } from "./worker-serial";

async function fixture(prefix: Uint8Array[], maybeHook?: WorkerSerialQualificationHook) {
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
  if (!maybeHook) return h;
  const input = { ...h.input, [workerSerialQualificationHook]: maybeHook };
  return { ...h, controller: createWebSerialWorkerController(input) };
}
function credit(sequence: number, payload: Record<string, unknown> = { op: "receive_credit", receivedBytes: 1024 }) {
  return encodeWorkerSerialEnvelope({ profile: WORKER_SERIAL_PROFILE, kind: "session", sessionId: "AAAAAAAAAAAAAAAAAAAAAA", sequence, payload });
}

test("a queued old control reply does not replace fresh Hello admission", async () => {
  // Arrange
  const reply = await encodeWorkerSerialEnvelope({
    profile: WORKER_SERIAL_PROFILE, kind: "control", sessionId: "AAAAAAAAAAAAAAAAAAAAAA",
    sequence: 12, payload: { protocolVersion: "bwg-worker-controller/0.4", requestId: "serial_old_request", ok: true, result: { state: "baseline" } },
  });
  const h = await fixture([reply]);
  // Act
  const admission = await h.controller.requestPermission();
  await h.controller.close();
  // Assert
  expect(admission.status).toBe("ready");
  expect(h.counts()).toMatchObject({ closed: 1, locked: false, active: false });
});

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

async function staleReply() {
  return encodeWorkerSerialEnvelope({ profile: WORKER_SERIAL_PROFILE, kind: "control", sessionId: "AAAAAAAAAAAAAAAAAAAAAA", sequence: 3,
    payload: { protocolVersion: "bwg-worker-controller/0.4", requestId: "serial_old_request", ok: true, result: {} } });
}
async function staleAck() {
  return encodeWorkerSerialEnvelope({ profile: WORKER_SERIAL_PROFILE, kind: "session", sessionId: "AAAAAAAAAAAAAAAAAAAAAA", sequence: 0,
    payload: { op: "hello_ack", hostNonce: "A".repeat(43), deviceNonce: "A".repeat(43), serialManifest: WORKER_SERIAL_MANIFEST,
      firmwareSourceCommit: "c".repeat(40), appElfSha256: "d".repeat(64), receiveWindowBytes: 2048, receivedBytes: 0 } });
}

test.each(["coalesced", "fragmented"])("mixed stale device records allow fresh admission when %s", async mode => {
  // Arrange
  const frames = [await staleReply(), await credit(4), await staleAck(),
    await encodeWorkerSerialEnvelope({ profile: WORKER_SERIAL_PROFILE, kind: "heartbeat", sessionId: "AAAAAAAAAAAAAAAAAAAAAA", sequence: 5, payload: {} }),
    await encodeWorkerSerialEnvelope({ profile: WORKER_SERIAL_PROFILE, kind: "diagnostic", sessionId: "AAAAAAAAAAAAAAAAAAAAAA", sequence: 6, payload: { line: "old diagnostic" } }),
    new TextEncoder().encode('{"partial":\n')];
  const bytes = Uint8Array.from(frames.flatMap(frame => [...frame]));
  const chunks = mode === "coalesced" ? [bytes] : Array.from({ length: Math.ceil(bytes.length / 17) }, (_, index) => bytes.slice(index * 17, (index + 1) * 17));
  const diagnostics: unknown[] = [];
  const recoveries: unknown[] = [];
  const h = await fixture(chunks, { suppressHeartbeats: false, maybeObserveDiagnostic: value => diagnostics.push(value), maybeObserveHelloRecovery: value => recoveries.push(value) });
  // Act
  const admission = await h.controller.requestPermission();
  const probe = await h.controller.transportProbe();
  await h.controller.close();
  // Assert
  expect(admission.status).toBe("ready");
  expect(probe.requestPayloadBytes).toBe(65536);
  expect(h.counts()).toMatchObject({ closed: 1, locked: false, active: false });
  expect(h.received.some(frame => frame.command === "start_lease")).toBeFalse();
  expect(diagnostics).toEqual([]);
  expect(recoveries).toEqual([{ discardedRecords: 5, discardedBytes: bytes.length }]);
});

test.each([32, 33])("bootstrap limits all old records together to 32: %s", async count => {
  // Arrange
  const h = await fixture(await Promise.all(Array.from({ length: count }, (_, index) => index % 2 ? credit(index + 1) : staleReply())));
  // Act
  const admitted = await h.controller.requestPermission().then(() => true, () => false);
  await h.controller.close();
  // Assert
  expect(admitted).toBe(count === 32);
  expect(h.counts()).toMatchObject({ closed: 1, locked: false, active: false });
});

test.each([66560, 66561])("aggregate bootstrap counts original lexical bytes: %s", async total => {
  // Arrange: outer JSON whitespace changes wire size without changing integrity.
  const reply = new TextDecoder().decode(await staleReply());
  const first = reply.slice(0, -1) + " ".repeat(33000 - new TextEncoder().encode(reply).length) + "\n";
  const second = reply.slice(0, -1) + " ".repeat(total - 33000 - new TextEncoder().encode(reply).length) + "\n";
  const h = await fixture([new TextEncoder().encode(first + second)]);
  // Act
  const admitted = await h.controller.requestPermission().then(() => true, () => false);
  await h.controller.close();
  // Assert
  expect(admitted).toBe(total === 66560);
  expect(h.counts()).toMatchObject({ closed: 1, locked: false, active: false });
});

test("partial prefix and boot text consume the same aggregate budget as old replies", async () => {
  // Arrange
  const h = await fixture([new TextEncoder().encode("boot\n{" + " ".repeat(66553) + "\n"), await staleReply()]);
  // Act / Assert
  await expect(h.controller.requestPermission()).rejects.toThrow();
  await h.controller.close();
  expect(h.counts()).toMatchObject({ closed: 1, locked: false });
});

test.each(["request", "zero_sequence", "bad_ack_nonce", "close", "invalid_id", "long_id"])("invalid stale %s never becomes bootstrap tolerance", async kind => {
  // Arrange
  const frame = JSON.parse(new TextDecoder().decode(kind === "bad_ack_nonce" ? await staleAck() : await staleReply()));
  if (kind === "request") frame.payload = { protocolVersion: "bwg-worker-controller/0.4", requestId: "old", command: "status" };
  if (kind === "zero_sequence") frame.sequence = 0;
  if (kind === "invalid_id") frame.payload.requestId = "old";
  if (kind === "long_id") frame.payload.requestId = "serial_" + "x".repeat(122);
  if (kind === "bad_ack_nonce") frame.payload.hostNonce = "invalid";
  if (kind === "close") { frame.kind = "session"; frame.payload = { op: "close" }; }
  const h = await fixture([await encodeWorkerSerialEnvelope(frame)]);
  // Act / Assert
  await expect(h.controller.requestPermission()).rejects.toThrow();
  await h.controller.close();
  expect(h.counts()).toMatchObject({ closed: 1, locked: false, active: false });
});

test("stale acknowledgements alone never authorize discover and time out", async () => {
  // Arrange
  const h = await fixture([await staleAck(), await staleReply()]);
  const runtime = h.input[workerSerialTestRuntime].runtime;
  const requestPort = runtime.serial.requestPort.bind(runtime.serial);
  runtime.serial.requestPort = async options => {
    const port = await requestPort(options);
    return { getInfo: () => port.getInfo(), get readable() { return port.readable; }, writable: new WritableStream<Uint8Array>(), open: options => port.open(options), close: () => port.close() };
  };
  // Act
  const began = performance.now();
  await expect(h.controller.requestPermission()).rejects.toThrow();
  await h.controller.close();
  // Assert
  expect(performance.now() - began).toBeLessThan(4000);
  expect(h.received).toHaveLength(0);
  expect(h.counts()).toMatchObject({ closed: 1, locked: false, active: false });
});

test("queued possession proof from interrupted admission is discarded before fresh proof", async () => {
  // Arrange: the published conformance proof is intentionally for an old transcript.
  const { default: possession } = await import("../conformance/bwg-worker-possession-0.2/fixtures.json");
  const bytes = await encodeWorkerSerialEnvelope({ profile: WORKER_SERIAL_PROFILE, kind: "control", sessionId: "AAAAAAAAAAAAAAAAAAAAAA", sequence: 3,
    payload: possession.initialAdmission.response });
  const h = await fixture([bytes]);
  // Act
  const admission = await h.controller.requestPermission();
  await h.controller.close();
  // Assert: fresh possession still occurs after the discarded, unverified proof.
  expect(admission.status).toBe("ready");
  expect(h.received.filter(frame => frame.command === "prove_possession")).toHaveLength(1);
  expect(h.counts()).toMatchObject({ closed: 1, locked: false, active: false });
});

test.each(["proof_unavailable", "bad_id", "bad_claims"])("stale possession %s obeys the existing response parser", async kind => {
  // Arrange
  const { default: possession } = await import("../conformance/bwg-worker-possession-0.2/fixtures.json");
  const payload: Record<string, unknown> = kind === "proof_unavailable"
    ? { profile: "bwg-worker-possession/0.2", requestId: "pos_old", ok: false, error: { code: "proof_unavailable", message: "Old proof unavailable" } }
    : { ...structuredClone(possession.initialAdmission.response) };
  if (kind === "bad_id") payload.requestId = "serial_old";
  if (kind === "bad_claims") payload.result = { claims: {}, compactJws: "invalid" };
  const h = await fixture([await encodeWorkerSerialEnvelope({ profile: WORKER_SERIAL_PROFILE, kind: "control", sessionId: "AAAAAAAAAAAAAAAAAAAAAA", sequence: 3, payload })]);
  // Act
  const ready = await h.controller.requestPermission().then(() => true, () => false);
  await h.controller.close();
  // Assert
  expect(ready).toBe(kind === "proof_unavailable");
  expect(h.counts()).toMatchObject({ closed: 1, locked: false, active: false });
});
