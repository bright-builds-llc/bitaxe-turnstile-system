import { expect, test } from "bun:test";
import { serialHarness } from "./worker-serial.test-support";
import { createWebSerialWorkerController, workerSerialQualificationHook } from "./webserial-worker-controller";
import { WorkerSerialRestartObserver } from "./worker-serial-restart-observer";
import { restartBootBytes } from "./worker-restart.fixture";
import { createWorkerCoreDumpPageOperations } from "./worker-restart-page";

const request = { requestNonce: "A".repeat(22), expectedBootOrdinal: 1 };
async function fixture(mode: "same_stream" | "missing_boot" = "same_stream") {
  const h = await serialHarness(); h.setRestartScenario(mode);
  const input = { ...h.input, [workerSerialQualificationHook]: { suppressHeartbeats: false, allowCoreDumpSelfTest: true } };
  const controller = createWebSerialWorkerController(input);
  await controller.requestPermission(); return { h, controller };
}
test("self-test uses authenticated distinct command and retains fresh panic observation", async () => {
  // Arrange
  const f = await fixture();
  try {
    // Act
    const result = await f.controller.coreDumpSelfTest(request);
    // Assert
    expect(result.summary).toMatchObject({ schema: "worker-qualification-core-dump-self-test-observation-v1", stage: "complete", panicResetObserved: true, softwareResetObserved: false, identityMatched: true });
    expect(result.ack?.schema).toBe("worker-qualification-core-dump-self-test-v1");
    expect(JSON.stringify(result)).not.toContain(request.requestNonce);
    expect(f.h.received.filter(value => value.command === "qualification_core_dump_self_test")).toHaveLength(1);
    expect(f.h.received.filter(value => value.command === "qualification_restart")).toHaveLength(0);
    expect(f.h.received.filter(value => value.command === "discover")).toHaveLength(2);
    await expect(f.controller.coreDumpSelfTest({ ...request, expectedBootOrdinal: 2 })).rejects.toThrow();
  } finally { await f.controller.close(); }
});
test("self-test capability is absent from ordinary adapters", async () => {
  const h = await serialHarness(); await h.controller.requestPermission(); const before = h.received.length;
  try { await expect(h.controller.coreDumpSelfTest(request)).rejects.toThrow(); expect(h.received.length).toBe(before); }
  finally { await h.controller.close(); }
});
test("active work blocks self-test before fresh proof or diagnostic effect", async () => {
  const f = await fixture();
  try {
    const grant = await f.h.grant(await f.controller.prepareWorkerLeaseAuthorizationContext("start")); await f.controller.startLease(grant);
    const before = f.h.received.length;
    await expect(f.controller.coreDumpSelfTest(request)).rejects.toThrow(); expect(f.h.received.length).toBe(before);
  } finally { await f.controller.close(); }
});
test("missing self-test reboot releases ownership and retains partial ACK evidence", async () => {
  const f = await fixture("missing_boot");
  const outcome = f.controller.coreDumpSelfTest(request).then(() => undefined, error => error);
  for (let index = 0; index < 200 && !f.controller.qualificationRestartSummary()?.ackMatched; index++) await new Promise(resolve => setTimeout(resolve, 0));
  expect(f.controller.qualificationRestartSummary()?.ackMatched).toBeTrue();
  await f.h.advance(30100); expect(await outcome).toBeInstanceOf(Error);
  expect(f.controller.qualificationRestartEvidence()?.ack?.schema).toBe("worker-qualification-core-dump-self-test-v1");
  expect(f.h.counts()).toMatchObject({ closed: 1, locked: false });
});
test.each(["restart", "core_dump_self_test"] as const)("%s never accepts the other reset reason", kind => {
  const observer = new WorkerSerialRestartObserver(request, { firmwareSourceCommit: "a".repeat(40), appElfSha256: "b".repeat(64) }, () => 0, "c".repeat(64), kind);
  observer.acknowledge({ schema: kind === "restart" ? "worker-qualification-restart-v1" : "worker-qualification-core-dump-self-test-v1", requestNonce: request.requestNonce, bootOrdinal: 1, nextBootOrdinal: 2 });
  const bytes = restartBootBytes(2, true, 1000, kind === "restart" ? "panic" : "software_cpu");
  expect(() => observer.rawRecord(bytes.slice(0, bytes.indexOf(10)))).toThrow();
});
test("page capability rejects disabled and non-idle invocations", async () => {
  for (const [enabled, idle] of [[false, true], [true, false]]) {
    let called = false;
    const page = createWorkerCoreDumpPageOperations({ enabled: () => enabled!, idle: () => idle!, maybeController: () => ({ coreDumpSelfTest: async () => { called = true; throw new Error("unexpected"); }, qualificationRestartEvidence: () => undefined }), before() {}, succeeded() {}, failed() {} });
    await expect(page.coreDumpSelfTest(request)).rejects.toThrow(); expect(called).toBeFalse();
  }
});

test("native page preserves before/candidate baseline and prevents a second self-test after reconnect", async () => {
  const child = Bun.spawn(["bun", new URL("./worker-core-dump-page-lifecycle.fixture.ts", import.meta.url).pathname], { stdout: "pipe", stderr: "pipe" });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(stderr).toBe(""); expect(code).toBe(0);
});
