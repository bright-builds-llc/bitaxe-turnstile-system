import { expect, test } from "bun:test";
import { sha256Base64UrlBytes } from "./crypto-bytes";
import {
  WORKER_SERIAL_PROFILE,
  WORKER_SERIAL_MANIFEST,
  WorkerSerialFramer,
  WorkerSerialPeer,
  encodeWorkerSerialEnvelope,
  parseWorkerSerialEnvelope,
  parseWorkerSerialManifest,
  type WorkerSerialEnvelope,
} from "./worker-serial";
const session = "AAAAAAAAAAAAAAAAAAAAAA";
function frame(
  kind: WorkerSerialEnvelope["kind"] = "heartbeat",
  sequence = 1,
): WorkerSerialEnvelope {
  return {
    profile: WORKER_SERIAL_PROFILE,
    kind,
    sessionId: session,
    sequence,
    payload: {},
  };
}
test("split and coalesced serial frames preserve complete current-session messages", async () => {
  // Arrange
  const reader = new WorkerSerialFramer();
  const a = await encodeWorkerSerialEnvelope(frame());
  const b = await encodeWorkerSerialEnvelope(frame("heartbeat", 2));
  // Act
  const first = await reader.push(a.slice(0, 10));
  const remainder = await reader.push(new Uint8Array([...a.slice(10), ...b]));
  // Assert
  expect(first).toEqual([]);
  expect(remainder.map((value) => value.sequence)).toEqual([1, 2]);
});
test("exact control payload bound is accepted and one byte beyond fails", async () => {
  // Arrange
  const overhead = new TextEncoder().encode(
    JSON.stringify({ padding: "" }),
  ).length;
  const value = {
    ...frame("control"),
    payload: { padding: "x".repeat(65536 - overhead) },
  };
  // Act / Assert
  expect(
    await new WorkerSerialFramer().push(await encodeWorkerSerialEnvelope(value)),
  ).toHaveLength(1);
  await expect(
    encodeWorkerSerialEnvelope({
      ...value,
      payload: { padding: value.payload.padding + "x" },
    }),
  ).rejects.toThrow();
});
test("serial boundary rejects invalid UTF8, unknown fields, overflow and malformed heartbeat", async () => {
  // Arrange / Act / Assert
  const valid = JSON.parse(new TextDecoder().decode(await encodeWorkerSerialEnvelope(frame())));
  await expect(
    new WorkerSerialFramer().push(new Uint8Array([255, 10])),
  ).rejects.toThrow();
  await expect(new WorkerSerialFramer().push(new Uint8Array(66561))).rejects.toThrow();
  expect(() =>
    parseWorkerSerialEnvelope({ ...valid, extra: true }),
  ).toThrow();
  expect(() =>
    parseWorkerSerialEnvelope({ ...valid, sequence: 4294967296 }),
  ).toThrow();
  expect(() =>
    parseWorkerSerialEnvelope({ ...valid, payload: { padding: "secret" } }),
  ).toThrow();
  expect(() =>
    parseWorkerSerialManifest({
      ...WORKER_SERIAL_MANIFEST,
      heartbeatTimeoutMilliseconds: 3000,
    }),
  ).toThrow();
});
test("ordinary traffic does not refresh peer heartbeat and exact cutoff revokes", async () => {
  // Arrange
  const peer = new WorkerSerialPeer(session, 0);
  // Act
  peer.receive(frame("control"), 2000);
  // Assert
  expect(peer.expired(2799)).toBeFalse();
  expect(peer.expired(2800)).toBeTrue();
});
test("wrong-session and replayed heartbeat cannot revive a revoked peer", async () => {
  // Arrange
  const peer = new WorkerSerialPeer(session, 0);
  peer.receive(frame(), 1000);
  // Act / Assert
  expect(() => peer.receive(frame(), 2000)).toThrow();
  expect(peer.expired(2000)).toBeTrue();
  const other = new WorkerSerialPeer(session, 0);
  expect(() =>
    other.receive({ ...frame(), sessionId: "AQEBAQEBAQEBAQEBAQEBAQ" }, 100),
  ).toThrow();
});

test("raw control payload whitespace cannot bypass the published 64 KiB limit", async () => {
  // Arrange
  const rawPayload = `{${" ".repeat(65535)}}`;
  const payloadUtf8 = new TextEncoder().encode(rawPayload);
  const digest = await sha256Base64UrlBytes(payloadUtf8);
  const text = ` {"payload":${rawPayload},"payloadBytes":${payloadUtf8.length},"payloadSha256":"${digest}","sequence":1,"sessionId":"${session}","kind":"control","profile":"${WORKER_SERIAL_PROFILE}"}\n`;
  // Act / Assert
  await expect(
    new WorkerSerialFramer().push(new TextEncoder().encode(text)),
  ).rejects.toMatchObject({ category: "payload_bound" });
});

test("duplicate decoded envelope keys and lone surrogate strings are rejected", async () => {
  // Arrange
  const text = new TextDecoder().decode(await encodeWorkerSerialEnvelope(frame())).trimEnd().replace(
    '"sequence":1',
    '"sequence":1,"sequence":2',
  );
  const surrogate = new TextDecoder().decode(await encodeWorkerSerialEnvelope({
    ...frame("control"),
    payload: { value: "\ud800" },
  })).trimEnd();
  // Act / Assert
  for (const invalid of [text, surrogate])
    await expect(
      new WorkerSerialFramer().push(new TextEncoder().encode(invalid + "\n")),
    ).rejects.toThrow();
});

test("envelope order and surrounding JSON whitespace do not change admission", async () => {
  // Arrange
  const encoded = JSON.parse(new TextDecoder().decode(await encodeWorkerSerialEnvelope(frame())));
  const text = ` { "payload":{}, "payloadBytes":${encoded.payloadBytes}, "payloadSha256":"${encoded.payloadSha256}", "sequence":1, "sessionId":"${session}", "kind":"heartbeat", "profile":"${WORKER_SERIAL_PROFILE}" } \n`;
  // Act / Assert
  expect(await new WorkerSerialFramer().push(new TextEncoder().encode(text))).toEqual(
    [frame()],
  );
});

test("literal CRLF framing is rejected while escaped JSON CR remains valid", async () => {
  // Arrange
  const crlf = new TextDecoder().decode(await encodeWorkerSerialEnvelope(frame())).trimEnd() + "\r\n";
  const escaped = { ...frame("control"), payload: { value: "\r" } };
  // Act / Assert
  await expect(
    new WorkerSerialFramer().push(new TextEncoder().encode(crlf)),
  ).rejects.toThrow();
  expect(
    await new WorkerSerialFramer().push(await encodeWorkerSerialEnvelope(escaped)),
  ).toEqual([escaped]);
});
