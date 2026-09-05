import { expect, test } from "bun:test";
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
test("split and coalesced serial frames preserve complete current-session messages", () => {
  // Arrange
  const reader = new WorkerSerialFramer();
  const a = encodeWorkerSerialEnvelope(frame());
  const b = encodeWorkerSerialEnvelope(frame("heartbeat", 2));
  // Act
  const first = reader.push(a.slice(0, 10));
  const remainder = reader.push(new Uint8Array([...a.slice(10), ...b]));
  // Assert
  expect(first).toEqual([]);
  expect(remainder.map((value) => value.sequence)).toEqual([1, 2]);
});
test("exact control payload bound is accepted and one byte beyond fails", () => {
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
    new WorkerSerialFramer().push(encodeWorkerSerialEnvelope(value)),
  ).toHaveLength(1);
  expect(() =>
    encodeWorkerSerialEnvelope({
      ...value,
      payload: { padding: value.payload.padding + "x" },
    }),
  ).toThrow();
});
test("serial boundary rejects invalid UTF8, unknown fields, overflow and malformed heartbeat", () => {
  // Arrange / Act / Assert
  expect(() =>
    new WorkerSerialFramer().push(new Uint8Array([255, 10])),
  ).toThrow();
  expect(() => new WorkerSerialFramer().push(new Uint8Array(66561))).toThrow();
  expect(() =>
    parseWorkerSerialEnvelope({ ...frame(), extra: true }),
  ).toThrow();
  expect(() =>
    parseWorkerSerialEnvelope({ ...frame(), sequence: 4294967296 }),
  ).toThrow();
  expect(() =>
    parseWorkerSerialEnvelope({ ...frame(), payload: { padding: "secret" } }),
  ).toThrow();
  expect(() =>
    parseWorkerSerialManifest({
      ...WORKER_SERIAL_MANIFEST,
      heartbeatTimeoutMilliseconds: 3000,
    }),
  ).toThrow();
});
test("ordinary traffic does not refresh peer heartbeat and exact cutoff revokes", () => {
  // Arrange
  const peer = new WorkerSerialPeer(session, 0);
  // Act
  peer.receive(frame("control"), 2000);
  // Assert
  expect(peer.expired(2799)).toBeFalse();
  expect(peer.expired(2800)).toBeTrue();
});
test("wrong-session and replayed heartbeat cannot revive a revoked peer", () => {
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

test("raw control payload whitespace cannot bypass the published 64 KiB limit", () => {
  // Arrange
  const rawPayload = `{${" ".repeat(65535)}}`;
  const text = ` {"payload":${rawPayload},"sequence":1,"sessionId":"${session}","kind":"control","profile":"${WORKER_SERIAL_PROFILE}"}\n`;
  // Act / Assert
  expect(() =>
    new WorkerSerialFramer().push(new TextEncoder().encode(text)),
  ).toThrow();
});

test("duplicate decoded envelope keys and lone surrogate strings are rejected", () => {
  // Arrange
  const text = JSON.stringify(frame()).replace(
    '"sequence":1',
    '"sequence":1,"sequence":2',
  );
  const surrogate = JSON.stringify({
    ...frame("control"),
    payload: { value: "\ud800" },
  });
  // Act / Assert
  for (const invalid of [text, surrogate])
    expect(() =>
      new WorkerSerialFramer().push(new TextEncoder().encode(invalid + "\n")),
    ).toThrow();
});

test("envelope order and surrounding JSON whitespace do not change admission", () => {
  // Arrange
  const text = ` { "payload":{}, "sequence":1, "sessionId":"${session}", "kind":"heartbeat", "profile":"${WORKER_SERIAL_PROFILE}" } \n`;
  // Act / Assert
  expect(new WorkerSerialFramer().push(new TextEncoder().encode(text))).toEqual(
    [frame()],
  );
});

test("literal CRLF framing is rejected while escaped JSON CR remains valid", () => {
  // Arrange
  const crlf = JSON.stringify(frame()) + "\r\n";
  const escaped = { ...frame("control"), payload: { value: "\r" } };
  // Act / Assert
  expect(() =>
    new WorkerSerialFramer().push(new TextEncoder().encode(crlf)),
  ).toThrow();
  expect(
    new WorkerSerialFramer().push(encodeWorkerSerialEnvelope(escaped)),
  ).toEqual([escaped]);
});
