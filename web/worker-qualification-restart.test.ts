import { expect, test } from "bun:test";
import { parseQualificationRestartAck, parseQualificationRestartRequest, qualificationRestartNonceDigest } from "./worker-qualification-restart";
import { restartBootBytes, type RestartFixtureMode } from "./worker-restart.fixture";
import { serialHarness } from "./worker-serial.test-support";
import { workerSerialTestRuntime } from "./webserial-worker-port";
import { createWebSerialWorkerController, workerSerialQualificationHook } from "./webserial-worker-controller";

const request = { requestNonce: "A".repeat(22), expectedBootOrdinal: 1 };
const ack = { schema: "worker-qualification-restart-v1", requestNonce: request.requestNonce, bootOrdinal: 1, nextBootOrdinal: 2 } as const;
async function fixture(mode: RestartFixtureMode = "same_stream") {
  const h = await serialHarness(); h.setRestartScenario(mode); const runtime = h.input[workerSerialTestRuntime].runtime;
  let selections = 0, locks = 0; const select = runtime.serial.requestPort.bind(runtime.serial), lock = runtime.acquireLock.bind(runtime);
  runtime.serial.requestPort = input => { selections++; return select(input); }; runtime.acquireLock = () => { locks++; return lock(); };
  const input = { ...h.input, [workerSerialQualificationHook]: { suppressHeartbeats: false, allowQualificationRestart: true } };
  const controller = createWebSerialWorkerController(input); await controller.requestPermission(); runtime.userActivation = () => false;
  return { h, controller, selections: () => selections, locks: () => locks };
}
test("restart request and ACK require exact canonical nonce and successor boot", () => {
  expect(parseQualificationRestartRequest(request)).toEqual(request); expect(parseQualificationRestartAck(ack, request)).toEqual(ack);
  for (const change of [{ requestNonce: "B".repeat(22) }, { expectedBootOrdinal: 0 }, { expectedBootOrdinal: Number.MAX_SAFE_INTEGER }, { raw: "private" }]) expect(() => parseQualificationRestartRequest({ ...request, ...change })).toThrow();
  for (const change of [{ requestNonce: "g".repeat(22) }, { bootOrdinal: 2 }, { nextBootOrdinal: 3 }, { raw: "private" }]) expect(() => parseQualificationRestartAck({ ...ack, ...change }, request)).toThrow();
});
test("actual controller retains coalesced ACK and boot bytes without releasing or selecting a port", async () => {
  // Arrange
  const f = await fixture();
  try {
    // Act
    const result = await f.controller.qualificationRestart(request);
    // Assert
    expect(result.summary).toMatchObject({ stage: "complete", ackMatched: true, bootObserved: true, runtimeReadyObserved: true, identityMatched: true, continuity: "uninterrupted", portReopens: 0 });
    expect(result.ack).toEqual({ schema: ack.schema, requestNonceSha256: await qualificationRestartNonceDigest(request.requestNonce), bootOrdinal: 1, nextBootOrdinal: 2 });
    expect(JSON.stringify(result)).not.toContain(request.requestNonce);
    expect(result.observations.filter(value => value.diagnostic.category === "startup")).toHaveLength(2);
    expect(f.h.received.filter(value => value.command === "qualification_restart")).toHaveLength(1);
    expect(f.h.received.filter(value => value.command === "discover")).toHaveLength(2);
    expect(f.h.counts()).toMatchObject({ opened: 1, closed: 0, active: false, locked: true });
    expect(f.selections()).toBe(1); expect(f.locks()).toBe(1);
    await expect(f.controller.qualificationRestart({ ...request, expectedBootOrdinal: 2 })).rejects.toThrow();
  } finally { await f.controller.close(); }
});
test("one ended stream reopens only the retained granted port and records discontinuity", async () => {
  const f = await fixture("reopen_once"); let disconnects = 0;
  f.controller.subscribeDisconnect(async () => { disconnects++; });
  try {
    const result = await f.controller.qualificationRestart(request);
    expect(result.summary).toMatchObject({ stage: "complete", streamInterrupted: true, portReopens: 1, continuity: "same_port_reopened" });
    expect(f.selections()).toBe(1); expect(f.locks()).toBe(1);
    expect(f.h.counts()).toMatchObject({ opened: 2, closed: 1, locked: true });
    expect(disconnects).toBe(0);
  } finally { await f.controller.close(); }
});
test("a second stream interruption fails without a third open or a second reset", async () => {
  const f = await fixture("reopen_twice");
  await expect(f.controller.qualificationRestart(request)).rejects.toThrow();
  expect(f.h.counts().opened).toBe(2); expect(f.h.counts().locked).toBeFalse();
  expect(f.h.received.filter(value => value.command === "qualification_restart")).toHaveLength(1);
});
test("ordinary adapters cannot emit the qualification restart command", async () => {
  const h = await serialHarness(); await h.controller.requestPermission(); const before = h.received.length;
  try { await expect(h.controller.qualificationRestart(request)).rejects.toThrow(); expect(h.received.length).toBe(before); }
  finally { await h.controller.close(); }
});

test("active work rejects restart without another proof or reset request", async () => {
  const f = await fixture();
  try {
    const grant = await f.h.grant(await f.controller.prepareWorkerLeaseAuthorizationContext("start")); await f.controller.startLease(grant);
    const before = f.h.received.length;
    await expect(f.controller.qualificationRestart(request)).rejects.toThrow();
    expect(f.h.received.length).toBe(before);
  } finally { await f.controller.close(); }
});

test("missing boot evidence times out, retains the matching ACK digest and releases ownership", async () => {
  const f = await fixture("missing_boot");
  const outcome = f.controller.qualificationRestart(request).then(() => undefined, error => error);
  for (let index = 0; index < 200 && !f.controller.qualificationRestartSummary()?.ackMatched; index++) await new Promise(resolve => setTimeout(resolve, 0));
  expect(f.controller.qualificationRestartSummary()?.ackMatched).toBeTrue();
  await f.h.advance(30100); expect(await outcome).toBeInstanceOf(Error);
  expect(f.controller.qualificationRestartEvidence()?.ack?.requestNonceSha256).toBe(await qualificationRestartNonceDigest(request.requestNonce));
  expect(f.controller.qualificationRestartSummary()?.stage).toBe("failed");
  expect(f.h.counts()).toMatchObject({ closed: 1, locked: false });
  expect(f.h.received.filter(value => value.command === "qualification_restart")).toHaveLength(1);
});


test("EOF coalesced with a complete boot still requires fresh post-reopen observation", async () => {
  const f = await fixture("reopen_complete");
  try {
    const result = await f.controller.qualificationRestart(request);
    expect(result.summary).toMatchObject({ stage: "complete", continuity: "same_port_reopened", portReopens: 1 });
    const reopened = result.lifecycle.find(value => value.event === "same_port_reopened");
    expect(reopened).toBeDefined();
    expect(result.observations.filter(value => value.record > reopened!.record && value.diagnostic.category === "startup")).toHaveLength(2);
    expect(f.h.counts().opened).toBe(2);
  } finally { await f.controller.close(); }
});


test("coalesced ACK and old-boot snapshots wait for two fresh post-boot samples", async () => {
  // Arrange
  const f = await fixture("queued_prior_boot");
  const outcome = f.controller.qualificationRestart(request);
  const waitFor = async (ready: () => boolean) => {
    for (let index = 0; index < 200 && !ready(); index++) await new Promise(resolve => setTimeout(resolve, 0));
    expect(ready()).toBeTrue();
  };
  try {
    await waitFor(() => f.controller.qualificationRestartEvidence()?.observations.length === 4);
    expect(f.controller.qualificationRestartSummary()?.runtimeReadyObserved).toBeFalse();
    const fresh = new TextDecoder().decode(restartBootBytes(2)).trim().split("\n");
    // Act
    f.h.receiveRaw(new TextEncoder().encode(fresh.slice(0, 3).join("\n") + "\n"));
    await waitFor(() => f.controller.qualificationRestartEvidence()?.observations.length === 7);
    expect(f.controller.qualificationRestartSummary()?.runtimeReadyObserved).toBeFalse();
    expect(f.h.received.filter(value => value.command === "discover")).toHaveLength(1);
    f.h.receiveRaw(new TextEncoder().encode(fresh[3] + "\n"));
    const result = await outcome;
    // Assert
    expect(result.summary).toMatchObject({ stage: "complete", bootObserved: true, runtimeReadyObserved: true, identityMatched: true });
    expect(result.observations.filter(value => value.diagnostic.category === "startup")).toHaveLength(4);
    expect(f.h.received.filter(value => value.command === "discover")).toHaveLength(2);
  } finally { await f.controller.close(); }
});
