import { expect, test } from "bun:test";
import { serialHarness } from "./worker-serial.test-support";
import { selectWorkerPort, workerSerialTestRuntime, type WorkerSerialAccess, type WorkerSerialPort } from "./webserial-worker-port";

const FILTER = { usbVendorId: 0x303a, usbProductId: 0x1001 };
function fakePort(info: { usbVendorId?: number; usbProductId?: number }, connected?: boolean): WorkerSerialPort {
  return { readable: null, writable: null, ...(connected === undefined ? {} : { connected }), getInfo: () => info, async open() { }, async close() { } };
}
function access(granted: WorkerSerialPort[] | Error, chosen: WorkerSerialPort) {
  const calls = { chooser: 0 };
  const serial: WorkerSerialAccess = {
    async requestPort() { calls.chooser += 1; return chosen; },
    async getPorts() { if (granted instanceof Error) throw granted; return granted; },
  };
  return { serial, calls };
}

test("one granted attached Worker port is reused without opening the chooser", async () => {
  // Arrange
  const granted = fakePort(FILTER, true), f = access([granted], fakePort(FILTER));
  // Act
  const selected = await selectWorkerPort(f.serial, FILTER);
  // Assert
  expect(selected).toEqual({ port: granted, reused: true });
  expect(f.calls.chooser).toBe(0);
});

test("several matching grants are ambiguous and open the chooser", async () => {
  // Arrange
  const chosen = fakePort(FILTER), f = access([fakePort(FILTER), fakePort(FILTER)], chosen);
  // Act
  const selected = await selectWorkerPort(f.serial, FILTER);
  // Assert
  expect(selected).toEqual({ port: chosen, reused: false });
  expect(f.calls.chooser).toBe(1);
});

test("other devices, detached grants and listing failures never bypass the chooser", async () => {
  for (const granted of [[fakePort({ usbVendorId: 0x10c4, usbProductId: 0xea60 })], [fakePort(FILTER, false)], new Error("listing unavailable")]) {
    // Arrange
    const chosen = fakePort(FILTER), f = access(granted, chosen);
    // Act
    const selected = await selectWorkerPort(f.serial, FILTER);
    // Assert
    expect(selected).toEqual({ port: chosen, reused: false });
    expect(f.calls.chooser).toBe(1);
  }
});

test("a cancelled chooser selects nothing", async () => {
  // Arrange
  const serial: WorkerSerialAccess = { async requestPort() { throw new Error("cancelled"); }, async getPorts() { return []; } };
  // Act
  const selected = await selectWorkerPort(serial, FILTER);
  // Assert
  expect(selected).toEqual({ port: undefined, reused: false });
});

test("a reused grant still passes fresh Hello, possession and the maximum probe", async () => {
  // Arrange
  const h = await serialHarness();
  const serial = h.input[workerSerialTestRuntime].runtime.serial;
  const port = await serial.requestPort({ filters: [h.input.deviceFilter] });
  let chooser = 0;
  serial.requestPort = async () => { chooser += 1; return port; };
  serial.getPorts = async () => [port];
  // Act
  const connection = await h.controller.requestPermission();
  const probe = await h.controller.transportProbe();
  // Assert
  expect(connection.status).toBe("ready");
  expect(probe.responsePayloadBytes).toBe(65536);
  expect(chooser).toBe(0);
  await h.controller.close();
  expect(h.counts()).toMatchObject({ closed: 1, locked: false });
});
