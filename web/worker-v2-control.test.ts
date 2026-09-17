import { expect, test } from "bun:test";
import { WorkerV2SerialControl } from "./worker-v2-serial-control";
import { v2Idle, v2Admitted, v2Accepted, v2Input } from "./worker-v2-serial.fixture";
import { serialHarness } from "./worker-serial.test-support";
import { createWebSerialWorkerController, workerSerialQualificationHook } from "./webserial-worker-controller";
function fixture() {
  let result: unknown = v2Idle(), binding = "first", fresh = true;
  const calls: string[] = [];
  const control = new WorkerV2SerialControl({ requireScope() {}, maybeBinding: () => binding, possessionFresh: () => fresh, async request(command) { calls.push(command); return result; } });
  return { control, calls, result(value: unknown) { result = value; }, expire() { fresh = false; }, replace() { binding = "new"; }, binding: () => binding };
}
test("ambiguous channel Start consumes its slot and excludes competing work", async () => {
  const h = fixture(); await h.control.status("channel", null, h.binding()); h.result({ invalid: true });
  await expect(h.control.start(v2Input, h.binding())).rejects.toThrow();
  h.result(v2Admitted()); await expect(h.control.start(v2Input, h.binding())).rejects.toThrow("v2_start_admission");
  expect(h.calls).toEqual(["stratum_v2_status", "stratum_v2_channel_start"]); expect(h.control.fenced).toBeTrue();
});
test("admitted binding remains collectable after sixty seconds and terminal completion", async () => {
  const h = fixture(); await h.control.status("channel", null, h.binding()); h.result(v2Admitted()); await h.control.start(v2Input, h.binding());
  h.expire(); h.result(v2Accepted()); await h.control.status("channel", v2Input.attemptId, h.binding());
  await h.control.status("channel", v2Input.attemptId, h.binding()); expect(h.control.fenced).toBeFalse();
  h.replace(); await expect(h.control.status("channel", v2Input.attemptId, h.binding())).rejects.toThrow("v2_possession");
});
test("stale idle endpoint and connected-without-address never issue Start", async () => {
  const h = fixture(), idle = v2Idle(); idle.observation.stationIpv4 = null; h.result(idle);
  await h.control.status("channel", null, h.binding());
  await expect(h.control.start(v2Input, h.binding())).rejects.toThrow("v2_start_admission"); expect(h.calls).toHaveLength(1);
});
test("funded Share admission binds its qualification attempt once without diagnostic Start", async () => {
  const h = fixture(); h.result(v2Idle("share")); await h.control.status("share", null, h.binding()); h.control.admitShare(v2Input.attemptId, h.binding()); h.result(v2Admitted("share")); h.expire();
  await h.control.status("share", v2Input.attemptId, h.binding());
  expect(() => h.control.admitShare(v2Input.attemptId, h.binding())).toThrow(); expect(h.calls).toEqual(["stratum_v2_status", "stratum_v2_status"]);
});
test("actual controller preserves a pending Restore connection for scoped status and cancellation", async () => {
  const h = await serialHarness(), published: unknown[] = [];
  Object.assign(h.input, { [workerSerialQualificationHook]: { suppressHeartbeats: false, stratumV2Pair: { firmwareSourceCommit: "a".repeat(40), appElfSha256: "b".repeat(64), scope: "channel" }, observeStatus: (v: unknown) => published.push(v), maybeObserveDiagnostic: (v: unknown) => published.push(v) } });
  let result = v2Idle(); h.setNoiseHandler(async () => result);
  const controller = createWebSerialWorkerController(h.input); await controller.requestPermission();
  try {
    const { controlSessionBindingSha256: binding } = await controller.prepareWorkerLeaseAuthorizationContext("start");
    await controller.stratumV2Status("channel", null, binding); result = v2Admitted();
    await controller.stratumV2ChannelStart(v2Input, binding); h.setRestorationPending(true);
    await expect(controller.restore("cancelled")).rejects.toThrow("command_rejected");
    expect((await controller.stratumV2Status("channel", v2Input.attemptId, binding)).state).toBe("admitted");
    await expect(controller.stratumV2Status("share", v2Input.attemptId, binding)).rejects.toThrow();
    await expect(controller.transportProbe()).rejects.toThrow();
    result = v2Accepted(); await controller.stratumV2ChannelCancel(v2Input.attemptId, binding); h.setRestorationPending(false);
    expect((await controller.restore("cancelled")).restoration.status).toBe("confirmed");
    const text = JSON.stringify({ published, trace: controller.exportBrowserSerialTrace() });
    expect(text).not.toContain("192.168."); expect(text).not.toContain(v2Input.stratum.authorityPublicKey); expect(text).not.toContain(binding);
  } finally { h.setRestorationPending(false); await controller.close(); }
  expect(h.counts().locked).toBeFalse();
});

test("actual Share adapter signs Start and Renew while collecting V2 facts without diagnostic authority", async () => {
  const h = await serialHarness();
  Object.assign(h.input, { [workerSerialQualificationHook]: { suppressHeartbeats: false, stratumV2Pair: { firmwareSourceCommit: "a".repeat(40), appElfSha256: "b".repeat(64), scope: "share" } } });
  const result = v2Admitted("share"); result.state = result.record.state = "running";
  h.setNoiseHandler(async (_command, payload) => (payload as { attemptId: string | null }).attemptId === null ? v2Idle("share") : result);
  const controller = createWebSerialWorkerController(h.input); await controller.requestPermission();
  try {
    const context = await controller.prepareWorkerLeaseAuthorizationContext("start");
    const grant = await h.grant(context, { stratum: v2Input.stratum, qualificationAttempt: { schema: "worker-qualification-attempt-v1", id: v2Input.attemptId, ordinal: 18, purpose: "normal", maximumActiveMilliseconds: 180000 } });
    await controller.stratumV2Status("share", null, context.controlSessionBindingSha256);
    expect((await controller.startLease(grant)).state).toBe("mining");
    expect((await controller.stratumV2Status("share", v2Input.attemptId, context.controlSessionBindingSha256)).state).toBe("running");
    await expect(controller.stratumV2ChannelCancel(v2Input.attemptId, context.controlSessionBindingSha256)).rejects.toThrow();
    expect((await controller.renewLease(await h.renewal(await controller.prepareWorkerLeaseAuthorizationContext("renew")))).state).toBe("mining");
    expect((await controller.restore("cancelled")).state).toBe("baseline");
    expect(h.received.some(row => row.command === "stratum_v2_channel_start")).toBeFalse();
  } finally { await controller.close(); }
});

test("ordinary controller cannot infer V2 support from its unchanged signed capability", async () => {
  const h = await serialHarness(); await h.controller.requestPermission();
  try {
    const context = await h.controller.prepareWorkerLeaseAuthorizationContext("start");
    const grant = await h.grant(context, { stratum: v2Input.stratum });
    const before = h.received.length;
    await expect(h.controller.startLease(grant)).rejects.toThrow("v2_pair_admission");
    expect(h.received).toHaveLength(before);
  } finally { await h.controller.close(); }
});

test("production page serializes Share status with a held application poll and renewal", async () => {
  // Arrange: actual controller, page methods and application-read ownership.
  const { createWorkerV2PageOperations } = await import("./worker-v2-page");
  const { serializeWorkerAcceptanceRead } = await import("./worker-acceptance-fault");
  const h = await serialHarness();
  Object.assign(h.input, { [workerSerialQualificationHook]: { suppressHeartbeats: false, stratumV2Pair: { firmwareSourceCommit: "a".repeat(40), appElfSha256: "b".repeat(64), scope: "share" } } });
  const controller = createWebSerialWorkerController(h.input); await controller.requestPermission();
  let polling = false, reads = 0;
  let release: () => void = () => { throw Error("fixture_not_held"); };
  const held = new Promise<void>(resolve => { release = resolve; });
  const result = v2Admitted("share"); result.state = result.record.state = "running";
  h.setNoiseHandler(async (_command, payload) => { if ((payload as { attemptId: string | null }).attemptId === null) return v2Idle("share"); reads++; await held; return result; });
  const serializeRead = <T>(run: () => Promise<T>) => serializeWorkerAcceptanceRead({ polling: () => polling, claim: value => { polling = value; }, run });
  const page = createWorkerV2PageOperations({ maybeReviewedBinding: () => undefined, serializeRead, changed() {}, phase: () => "candidate", scope: () => "share", connected: () => true, idle: () => false, controller: () => controller, maybePreservation: () => undefined });
  try {
    const context = await controller.prepareWorkerLeaseAuthorizationContext("start");
    await controller.stratumV2Status("share", null, context.controlSessionBindingSha256);
    await controller.startLease(await h.grant(context, { stratum: v2Input.stratum, qualificationAttempt: { schema: "worker-qualification-attempt-v1", id: v2Input.attemptId, ordinal: 18, purpose: "normal", maximumActiveMilliseconds: 180000 } }));
    // Act: a status read claims the same page flag checked by the renewal timer.
    const read = page.stratumV2Status("share", v2Input.attemptId, context.controlSessionBindingSha256);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(polling).toBeTrue(); expect(reads).toBe(1);
    const renewal = serializeRead(async () => controller.renewLease(await h.renewal(await controller.prepareWorkerLeaseAuthorizationContext("renew"))));
    expect(h.received.some(row => row.command === "renew_lease")).toBeFalse();
    release(); await read;
    expect((await renewal).state).toBe("mining");
    // Assert: the shared application slot is released, no collision or new Start.
    expect(polling).toBeFalse(); expect(h.received.filter(row => row.command === "start_lease")).toHaveLength(1);
  } finally { release(); await controller.close(); }
});

test("a replacement possession requires another Share idle network observation before Start", async () => {
  const h = fixture(); h.result(v2Idle("share"));
  await h.control.status("share", null, h.binding()); h.replace();
  expect(() => h.control.admitShare(v2Input.attemptId, h.binding())).toThrow("v2_share_network_admission");
  await h.control.status("share", null, h.binding());
  expect(() => h.control.admitShare(v2Input.attemptId, h.binding())).not.toThrow();
});

test("candidate Share page reads the existing passive endpoint without arming capture or persisting it", async () => {
  const { createWorkerV2PageOperations } = await import("./worker-v2-page");
  const h = await serialHarness(), published: unknown[] = [];
  Object.assign(h.input, { [workerSerialQualificationHook]: { suppressHeartbeats: false, stratumV2Pair: { firmwareSourceCommit: "a".repeat(40), appElfSha256: "b".repeat(64), scope: "share" }, maybeObserveDiagnostic: (v: unknown) => published.push(v), observeStatus: (v: unknown) => published.push(v) } });
  const controller = createWebSerialWorkerController(h.input); await controller.requestPermission();
  const idle = v2Idle("share"); h.setNoiseHandler(async () => idle);
  const endpoint = { schema: "worker-telemetry-endpoint-v1", ipv4: idle.observation.stationIpv4, httpPort: 80, observedAtUs: 200, bootOrdinal: 1, generation: 7 };
  h.setTelemetryEndpoint(endpoint); let running = false;
  const page = createWorkerV2PageOperations({ maybeReviewedBinding: () => undefined, serializeRead: run => run(), changed() {}, phase: () => "candidate", scope: () => "share", connected: () => true, idle: () => !running, controller: () => controller, maybePreservation: () => undefined });
  try {
    const binding = await page.stratumV2Possession(), before = h.received.length;
    const result = await page.stratumV2TelemetryEndpoint(binding);
    expect(result.bootOrdinal).toBe(1); expect(result.controlSessionBindingSha256).toBe(binding);
    expect(h.received.slice(before).filter(row => row.command).map(row => row.command)).toEqual(["stratum_v2_status", "telemetry_cadence_endpoint"]);
    expect(JSON.stringify(published)).not.toContain(endpoint.ipv4!);
    h.setTelemetryEndpoint({ ...endpoint, bootOrdinal: 2 });
    await expect(page.stratumV2TelemetryEndpoint(binding)).rejects.toThrow("v2_observer_binding");
    running = true; await expect(page.stratumV2TelemetryEndpoint(binding)).rejects.toThrow("v2_observer_admission");
  } finally { await controller.close(); }
});

test("returned Share network worker retains effect exclusion until physical restoration completes", async () => {
  const h = await serialHarness();
  Object.assign(h.input, { [workerSerialQualificationHook]: { suppressHeartbeats: false, stratumV2Pair: { firmwareSourceCommit: "a".repeat(40), appElfSha256: "b".repeat(64), scope: "share" } } });
  const status = v2Admitted("share"); status.state = status.record.state = "running";
  status.observation.observedAtUs = status.record.observedAtUs = 12000;
  status.record.resources = { socketClosed: true, workerQuiescent: true, fenceRetained: true, socketClosedAtUs: 9000, workerQuiescentAtUs: 11000 };
  h.setNoiseHandler(async (_command, payload) => (payload as { attemptId: string | null }).attemptId === null ? v2Idle("share") : status);
  const controller = createWebSerialWorkerController(h.input); await controller.requestPermission();
  try {
    const context = await controller.prepareWorkerLeaseAuthorizationContext("start"), binding = context.controlSessionBindingSha256;
    await controller.stratumV2Status("share", null, binding);
    await controller.startLease(await h.grant(context, { stratum: v2Input.stratum, qualificationAttempt: { schema: "worker-qualification-attempt-v1", id: v2Input.attemptId, ordinal: 18, purpose: "normal", maximumActiveMilliseconds: 180000 } }));
    h.setRestorationPending(true);
    await expect(controller.status()).rejects.toThrow("command_rejected");
    expect((await controller.stratumV2Status("share", v2Input.attemptId, binding)).record?.resources.fenceRetained).toBeTrue();
    await expect(controller.status()).rejects.toThrow("command_rejected");
    await expect(controller.restore("cancelled")).rejects.toThrow("command_rejected");
    expect((await controller.stratumV2Status("share", v2Input.attemptId, binding)).state).toBe("running");
    await expect(controller.transportProbe()).rejects.toThrow();
    h.setRestorationPending(false); status.state = status.record.state = "terminal"; status.record.outcome = "cancelled";
    status.record.terminalAtDeviceUs = 12000; status.record.firstFailure = { stage: "worker_quiescent", category: "authority", atDeviceUs: 12000 }; status.record.resources.fenceRetained = false;
    await controller.stratumV2Status("share", v2Input.attemptId, binding);
    expect((await controller.restore("cancelled")).restoration.status).toBe("confirmed");
  } finally { h.setRestorationPending(false); await controller.close(); }
});


test("fresh-session terminal collection binds retained reads beyond possession Start age", async () => {
  // Arrange: this controller first sees an already terminal retained job after reconnect.
  const h = fixture(); h.result(v2Accepted());
  // Act.
  await h.control.status("channel", v2Input.attemptId, h.binding()); h.expire();
  await h.control.status("channel", v2Input.attemptId, h.binding());
  await h.control.cancel(v2Input.attemptId, h.binding());
  // Assert: retained reads/cancel gain no idle admission or replacement-session authority.
  expect(h.control.fenced).toBeFalse();
  await expect(h.control.status("channel", null, h.binding())).rejects.toThrow("v2_possession");
  await expect(h.control.start(v2Input, h.binding())).rejects.toThrow("v2_possession");
  h.replace(); await expect(h.control.status("channel", v2Input.attemptId, h.binding())).rejects.toThrow("v2_possession");
});
