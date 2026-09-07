import { expect, test } from "bun:test";
import { boundedSerialReceiver } from "./worker-serial-flow.test-support";
import { WorkerSerialCredit, reserveSerialBytes } from "./worker-serial-credit";
import { encodeWorkerSerialEnvelope } from "./worker-serial";

test("uncredited native completion reproduces 64-byte-packet receive loss", async () => {
  // Arrange
  const h = boundedSerialReceiver();
  const bytes = await encodeWorkerSerialEnvelope(h.frame());
  // Act: the previous sender relied on this native-write completion alone.
  await h.injectUncredited(bytes);
  await h.channel.close();
  // Assert
  expect(h.counts().maximumBuffered).toBe(4096);
  expect(h.counts().dropped).toBe(bytes.length - 4096);
  expect(h.received).toEqual([]);
});

test("paused 4096-byte native receiver delivers maximum control without packet loss", async () => {
  // Arrange
  const h = boundedSerialReceiver();
  // Act
  const sending = h.channel.send(h.frame());
  await new Promise(resolve => setTimeout(resolve, 10));
  const paused = h.counts();
  await h.resume();
  await sending;
  await h.settled();
  await h.channel.close();
  // Assert
  expect(paused).toMatchObject({ reserved: 2048, consumed: 0, dropped: 0 });
  expect(h.counts().maximumBuffered).toBeLessThanOrEqual(2048);
  expect(h.counts().dropped).toBe(0);
  expect(h.counts().consumed).toBe(h.counts().reserved);
  expect(h.received).toEqual([h.frame()]);
});

test("cancellation of a partial record releases credit waiters and ignores late credit", async () => {
  // Arrange
  const h = boundedSerialReceiver();
  const sending = h.channel.send(h.frame()).then(() => "sent", () => "cancelled");
  await new Promise(resolve => setTimeout(resolve, 10));
  const before = h.counts().writes;
  // Act
  await h.channel.close();
  h.channel.receiveCredit(2048);
  await h.resume();
  // Assert
  expect(await sending).toBe("cancelled");
  expect(h.counts().writes).toBe(before);
  expect(h.received).toEqual([]);
});

test("lost credit expires one whole-record deadline without sending further bytes", async () => {
  // Arrange
  const h = boundedSerialReceiver();
  h.loseCredit();
  await h.resume();
  const began = performance.now();
  // Act / Assert
  await expect(h.channel.send(h.frame())).rejects.toMatchObject({ category: "timeout" });
  expect(performance.now() - began).toBeLessThan(2400);
  expect(h.counts().reserved).toBe(2048);
  const writes = h.counts().writes;
  h.channel.receiveCredit(2048);
  await h.settled();
  expect(h.counts().writes).toBe(writes);
  await h.channel.close();
});

test("deletion cannot dispatch a control even when native writes succeed", async () => {
  // Arrange
  const h = boundedSerialReceiver();
  h.losePacket();
  await h.resume();
  // Act / Assert
  await expect(h.channel.send(h.frame())).rejects.toMatchObject({ category: "timeout" });
  expect(h.counts().dropped).toBe(64);
  expect(h.received).toEqual([]);
  await h.channel.close();
});

test("credit arrives before native write settlement without allowing oversend", async () => {
  // Arrange
  const h = boundedSerialReceiver();
  await h.resume();
  // Act
  await h.channel.send(h.frame());
  await h.settled();
  await h.channel.close();
  // Assert
  expect(h.received).toHaveLength(1);
  expect(h.failures).toEqual([]);
  expect(h.counts().maximumBuffered).toBeLessThanOrEqual(2048);
});

test("a valid final short chunk does not resolve send without its consumption acknowledgement", async () => {
  // Arrange
  const h = boundedSerialReceiver();
  const bytes = await encodeWorkerSerialEnvelope(h.frame());
  h.withholdCreditAt(bytes.length);
  await h.resume();
  let settled = false;
  // Act
  const sending = h.channel.send(h.frame()).then(() => { settled = true; return "sent"; }, () => { settled = true; return "timeout"; });
  await new Promise(resolve => setTimeout(resolve, 50));
  // Assert
  expect(h.received).toEqual([h.frame()]);
  expect(settled).toBeFalse();
  expect(await sending).toBe("timeout");
  await h.channel.close();
});

test("credit rejects duplicates, rollback and acknowledgements beyond reservation", async () => {
  // Arrange
  const credit = new WorkerSerialCredit(); credit.admit();
  await credit.reserve(1024); credit.acknowledge(512);
  // Act / Assert
  for (const count of [512, 0, 1025, 4294967296, -1, 1.5, "1024"])
    expect(() => credit.acknowledge(count)).toThrow();
});

test("reservation rejects u32 exhaustion without wrapping", () => {
  // Arrange / Act / Assert
  expect(reserveSerialBytes(0xffffffff - 1, 0xffffffff - 1, 1)).toBe(1);
  expect(() => reserveSerialBytes(0xffffffff, 0xffffffff, 1)).toThrow();
});

test("queued heartbeat priority assigns advancing sequence at actual dequeue", async () => {
  // Arrange
  const h = boundedSerialReceiver();
  const first = h.channel.send(h.frame());
  const second = h.channel.send({ ...h.frame(), payload: { small: true } });
  const heartbeat = h.channel.send({ ...h.frame(), kind: "heartbeat", payload: {} });
  // Act
  await h.resume();
  await Promise.all([first, second, heartbeat]);
  await h.settled();
  await h.channel.close();
  // Assert
  expect(h.received.map(frame => [frame.kind, frame.sequence])).toEqual([["control", 1], ["heartbeat", 2], ["control", 3]]);
});
