import { expect, test } from "bun:test";
import { serialHarness } from "./worker-serial.test-support";
import { createWebSerialWorkerController, workerSerialQualificationHook, type WorkerSerialQualificationHook } from "./webserial-worker-controller";
import { workerSerialTestRuntime } from "./webserial-worker-port";

async function admissionFixture() {
  const h = await serialHarness();
  const stages: string[] = []; const ownership: boolean[] = [];
  const hook: WorkerSerialQualificationHook = { suppressHeartbeats: false, maybeObserveAdmissionFailure: stage => stages.push(stage), maybeObserveSerialOwnership: released => ownership.push(released) };
  const input = { ...h.input, [workerSerialQualificationHook]: hook };
  return { h, stages, ownership, hook, input, controller: () => createWebSerialWorkerController(input) };
}

test("scope failure reports only its closed stage and releases ownership", async () => {
  // Arrange
  const f = await admissionFixture(); f.hook.prepareScope = async () => { throw new Error("synthetic private input must not be projected"); };
  // Act / Assert
  await expect(f.controller().requestPermission()).rejects.toThrow();
  expect(f.stages).toEqual(["scope"]);
  expect(f.ownership).toEqual([false, true]);
  expect(f.h.counts()).toMatchObject({ opened: 0, locked: false });
});

test("native open rejection is distinguished from missing application hello", async () => {
  // Arrange
  const f = await admissionFixture();
  const runtime = f.input[workerSerialTestRuntime].runtime;
  const port = await runtime.serial.requestPort({ filters: [f.input.deviceFilter] });
  port.open = async () => { throw new Error("synthetic device path must not be projected"); };
  // Act / Assert
  await expect(f.controller().requestPermission()).rejects.toThrow();
  expect(f.stages).toEqual(["opening"]);
  expect(f.ownership).toEqual([false, true]);
});

test("cancel during native opening closes late success without sending hello", async () => {
  // Arrange
  const f = await admissionFixture(); const runtime = f.input[workerSerialTestRuntime].runtime;
  const port = await runtime.serial.requestPort({ filters: [f.input.deviceFilter] });
  const open = port.open.bind(port); let finish: () => void = () => { throw new Error("open not pending"); };
  port.open = () => new Promise<void>(resolve => { finish = () => { void open({ baudRate: 115_200, bufferSize: 66_560, flowControl: "none" }).then(resolve); }; });
  const controller = f.controller();
  const admission = controller.requestPermission().then(() => "ready", () => "cancelled");
  await f.h.advance(100);
  // Act
  const closed = controller.close(); finish(); await closed;
  // Assert
  expect(await admission).toBe("cancelled");
  expect(f.h.received).toHaveLength(0);
  expect(f.h.counts()).toMatchObject({ closed: 1, locked: false });
});

test("silent application reports hello failure while retaining local startup observations", async () => {
  // Arrange
  const f = await admissionFixture();
  const observations: unknown[] = [];
  f.hook.maybeObserveDiagnostic = value => observations.push(value);
  let closed = 0;
  const port = {
    getInfo: () => f.input.deviceFilter,
    readable: new ReadableStream<Uint8Array>({
      start(output) {
        output.enqueue(new TextEncoder().encode("usb_startup schema=v1 stage=network state=entered first_failure=none uptime_ms=123 redacted=true\n"));
      },
    }),
    writable: new WritableStream<Uint8Array>(),
    async open() { },
    async close() { closed += 1; },
  };
  f.input[workerSerialTestRuntime].runtime.serial.requestPort = async () => port;
  // Act / Assert
  await expect(f.controller().requestPermission()).rejects.toThrow();
  expect(f.stages).toEqual(["hello"]);
  expect(observations).toEqual([{ category: "startup", authoritative: false, stage: "network", state: "entered", first_failure: "none", uptime_ms: 123 }]);
  expect(closed).toBe(1);
  expect(f.ownership).toEqual([false, true]);
});

test("asynchronous reader failure preserves its admission stage after lifecycle closure", async () => {
  // Arrange
  const f = await admissionFixture();
  let failRead: () => void = () => { throw new Error("reader not installed"); };
  const port = {
    getInfo: () => f.input.deviceFilter,
    readable: new ReadableStream<Uint8Array>({ start(output) { failRead = () => output.error(new Error("synthetic private transport detail")); } }),
    writable: new WritableStream<Uint8Array>({ write() { failRead(); } }),
    async open() { },
    async close() { },
  };
  f.input[workerSerialTestRuntime].runtime.serial.requestPort = async () => port;
  // Act / Assert
  await expect(f.controller().requestPermission()).rejects.toThrow();
  expect(f.stages).toContain("hello");
  expect(f.ownership).toEqual([false, true]);
});
