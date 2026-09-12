import { expect, test } from "bun:test";
import { WorkerBrowserSerialTrace } from "./worker-browser-serial-trace";
import { parseBrowserSerialTrace, parseDeviceSerialTrace } from "./worker-serial-trace-export";

test("browser trace bounds retention and snapshots remain immutable across fresh epochs", () => {
  // Arrange
  const history = new WorkerBrowserSerialTrace(() => 12);
  const first = history.beginEpoch(); first.request(1); first.formedRequest(2); first.record("close_completed");
  const saved = history.snapshot();
  // Act
  const second = history.beginEpoch();
  for (let index = 0; index < 300; index++) second.record("chunk_received", 5);
  const current = parseBrowserSerialTrace(history.snapshot());
  // Assert
  expect(saved.events.every(event => event.epoch === 1)).toBeTrue();
  expect(current.events).toHaveLength(256); expect(current.overwrittenEvents).toBeGreaterThan(0);
  expect(current.events.every(event => event.epoch === 2)).toBeTrue();
  expect(current.events[0]?.ordinal).toBe(current.firstEventOrdinal);
});

test("browser parser refuses payload smuggling and invalid numerical observations", () => {
  // Arrange
  const history = new WorkerBrowserSerialTrace(() => 1); history.beginEpoch();
  const valid = history.snapshot();
  // Act / Assert
  for (const change of [{ payload: "private" }, { stage: "raw_wire" }, { wireBytes: -1 }, { atMs: Infinity }, { requestSequence: "private" }])
    expect(() => parseBrowserSerialTrace({ ...valid, events: [{ ...valid.events[0], ...change }] })).toThrow();
  expect(() => parseBrowserSerialTrace({ ...valid, raw: "private" })).toThrow();
});

test("maximum browser metadata export including its supervisor wrapper fits 65536 bytes", () => {
  // Arrange
  const max = Number.MAX_SAFE_INTEGER, u32 = 0xffff_ffff;
  const events = Array.from({ length: 256 }, (_, index) => ({ ordinal: max - 256 + index, epoch: u32, frameOrdinal: u32, requestOrdinal: u32, requestSequence: u32, stage: "validation_completed", atMs: max, wireBytes: u32, queuedBytes: u32 }));
  // Act
  const trace = parseBrowserSerialTrace({ schema: "worker-browser-serial-trace-v1", capacity: 256, firstEventOrdinal: max - 256, nextEventOrdinal: max, overwrittenEvents: max - 257, events });
  // Assert
  expect(new TextEncoder().encode(JSON.stringify({ stage: "recovered", source: "browser", trace })).length).toBeLessThanOrEqual(65536);
});

const window = (epoch: number) => ({ epoch, firstEventOrdinal: 1, nextEventOrdinal: 2, overwrittenEvents: 0,
  events: [{ ordinal: 1, epoch, requestSequence: 3, stage: "writer_queued", atMs: 4, wireBytes: 100, queuedBytes: 50 }] });
const device = () => ({ schema: "worker-serial-trace-v1", capacity: 64, snapshotAvailable: true, droppedEvents: 0, current: window(2), previous: window(1) });

test("device export keeps previous epoch and explicit unavailable snapshots", () => {
  expect(parseDeviceSerialTrace(device()).previous?.epoch).toBe(1);
  const unavailable = { schema: "worker-serial-trace-v1", capacity: 64, snapshotAvailable: false, droppedEvents: 1, current: { epoch: 0, firstEventOrdinal: 0, nextEventOrdinal: 0, overwrittenEvents: 0, events: [] }, previous: null };
  expect(parseDeviceSerialTrace(unavailable).snapshotAvailable).toBeFalse();
});

test.each([
  { previous: window(3) }, { current: { ...window(2), epoch: 3 } },
  { snapshotAvailable: false }, { droppedEvents: -1 }, { raw: "secret" },
  { current: { ...window(2), events: [{ ...window(2).events[0], payload: "private" }] } },
])("device trace malformed or inconsistent windows fail closed", change => {
  expect(() => parseDeviceSerialTrace({ ...device(), ...change })).toThrow();
});
