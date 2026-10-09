import { expect, test } from "bun:test";
import vectors from "../conformance/bwg-worker-controller-0.4/restoration-qualification-vectors.json";
import { parseWorkerControlResult } from "./worker-control-rejection";
import type { WorkerControllerStatus } from "./worker-controller";
import { createWorkerRestorationOperations, type WorkerRestorationController } from "./worker-restoration-operations";
import { WorkerRestorationJournal } from "./worker-restoration-journal";
import { WorkerRestorationHighWater, parseAuthorizationRejectionReview, parseClockDiscontinuityStimulusReview } from "./worker-restoration-qualification";
import { serialFailure } from "./worker-serial";
import { maybeWorkerSerialDiagnostic } from "./worker-serial-diagnostics";

const secret = "SECRET_AUTHORIZATION_VALUE";
const grant = { protocolVersion: "bwg-worker-controller/0.4", leaseId: "lease_secret_id", challengeId: "challenge_secret_id", authorization: secret,
  durationMilliseconds: 60000, renewAfterMilliseconds: 20000, stratum: { endpoint: "stratum+tcp://127.0.0.1:3333/", username: "pool-user-secret", password: "pool-password-secret" } };
const renewal = { protocolVersion: "bwg-worker-controller/0.4", leaseId: "lease_secret_id", authorization: `${secret}_renew`, durationMilliseconds: 60000, renewAfterMilliseconds: 20000 };
const mining = { protocolVersion: "bwg-worker-controller/0.4", state: "mining", monotonicMilliseconds: 1, lease: { leaseId: "lease_secret_id", challengeId: "challenge_secret_id", renewAtMonotonicMilliseconds: 20001, expiresAtMonotonicMilliseconds: 60001 }, restoration: { status: "pending" } } as WorkerControllerStatus;
const baseline = (reason: string) => ({ protocolVersion: "bwg-worker-controller/0.4", state: "baseline", monotonicMilliseconds: 2, restoration: { status: "confirmed", reason } }) as WorkerControllerStatus;
const rejection = (category: string) => { try { parseWorkerControlResult({ protocolVersion: "bwg-worker-controller/0.4", requestId: "serial_1", ok: false, error: { code: "command_rejected", message: category } }); } catch (error) { return error; } throw new Error("unreachable"); };

const admissionLine = (stage: string, failure: string, readiness = 7) =>
  `worker_admission schema=v1 stage=${stage} first_failure=${failure} readiness=${readiness} budget_reserved_ms=30000 budget_complete=false redacted=true`;
const diagnostic = (text: string) => { const value = maybeWorkerSerialDiagnostic(text); if (!value) throw new Error("fixture_diagnostic"); return value; };

function fixture(local: Record<string, unknown> = {}, enabled = true) {
  const calls: string[] = [];
  const posted: { path: string; body: unknown }[] = [];
  const highWater = new WorkerRestorationHighWater();
  let deviceStatus: WorkerControllerStatus = baseline("reboot");
  let maybeDisconnect: (() => Promise<void>) | undefined;
  let maybeStartError: unknown, maybeRenewError: unknown;
  const routes: Record<string, unknown> = { "/scenario-artifacts": { grant, renewals: [renewal] }, "/replay-artifact": { operation: "start", grant }, "/completion-context": { nonce: "n" },
    "/completion-review": { result: "passed", scenario: "completion", cleanup_confirmed: true }, "/physical-window": { checkpoint: "armed" }, ...local };
  const ops = createWorkerRestorationOperations({
    enabled: () => enabled, highWater, identity: () => ({}), publish() {}, flush: async () => { calls.push("flush"); },
    local: async (path: string, body?: object) => { posted.push({ path, body }); calls.push(path); return routes[path] ?? {}; },
    createController(): WorkerRestorationController {
      const observe = (value: WorkerControllerStatus) => { deviceStatus = value; ops.observeStatus(value); return value; };
      return {
        requestPermission: async () => { calls.push("permission"); highWater.observe({ authorization_high_water_sha256: "2".repeat(64) }); return { status: "ready", recovered: false }; },
        subscribeDisconnect(listener) { maybeDisconnect = () => listener("connectivity_lost"); return () => undefined; },
        status: async () => { calls.push("status"); return observe(deviceStatus); },
        prepareWorkerLeaseAuthorizationContext: async () => { calls.push("possess"); return { controlSessionBindingSha256: "B".repeat(43) }; },
        startLease: async () => { calls.push("start"); if (maybeStartError) throw maybeStartError; return observe(mining); },
        renewLease: async () => { calls.push("renew"); if (maybeRenewError) throw maybeRenewError; return observe(mining); },
        pause: async () => { calls.push("pause"); return observe(baseline("paused")); },
        cancel: async () => { calls.push("cancel"); return observe(baseline("cancelled")); },
        restore: async reason => { calls.push(`restore:${reason}`); return observe(baseline(reason)); },
        close: async reason => { calls.push(`close:${reason}`); },
        clockDiscontinuityStimulus: async () => { calls.push("stimulus"); return { ...vectors.stimulusAck.valid } as never; },
        clockDiscontinuityStimulusReview: async () => { calls.push("stimulus_review"); return parseClockDiscontinuityStimulusReview(vectors.stimulusReview.valid[2]); },
        authorizationRejectionReview: async () => { calls.push("rejection_review"); return parseAuthorizationRejectionReview(vectors.rejectionReview.valid[1]?.response); },
      };
    },
  });
  return { ops, calls, posted, highWater, endLease(reason: string) { deviceStatus = baseline(reason); }, disconnect: () => maybeDisconnect?.(),
    failStart(error: unknown) { maybeStartError = error; }, failRenew(error: unknown) { maybeRenewError = error; } };
}
async function running(f: ReturnType<typeof fixture>) {
  await f.ops.connect(); await f.ops.prepareStart(); await f.ops.loadScenarioLease(); await f.ops.startScenarioLease();
}

test("a scenario lease starts without scheduling any renewal, stop or poll", async () => {
  // Arrange
  const f = fixture();
  const [interval, timeout] = [globalThis.setInterval, globalThis.setTimeout];
  let scheduled = 0;
  globalThis.setInterval = (() => { scheduled += 1; return 0; }) as never; globalThis.setTimeout = (() => { scheduled += 1; return 0; }) as never;
  try {
    // Act
    await running(f);
  } finally { globalThis.setInterval = interval; globalThis.setTimeout = timeout; }
  // Assert
  expect(scheduled).toBe(0);
  expect(f.calls).toEqual(["permission", "status", "possess", "/authorization-context", "/scenario-artifacts", "start"]);
  expect(f.ops.state()).toMatchObject({ leaseActive: true, renewalsRemaining: 1 });
});

test("renewOnce sends exactly the one loaded renewal", async () => {
  // Arrange
  const f = fixture();
  await running(f);
  // Act
  await f.ops.renewOnce();
  // Assert
  expect(f.calls.filter(call => call === "renew")).toHaveLength(1);
  await expect(f.ops.renewOnce()).rejects.toThrow("renewal_exhausted");
});

test("the clock stimulus is one use per page lifetime and discards pending renewals", async () => {
  // Arrange
  const f = fixture();
  await running(f);
  // Act
  const ack = await f.ops.triggerClockDiscontinuity();
  // Assert
  expect(ack).toEqual({ schema: "worker-clock-discontinuity-stimulus-v1", offsetMilliseconds: 1000, armedForMilliseconds: 2000 });
  expect(JSON.stringify(ack)).not.toContain(vectors.stimulusAck.requestNonce);
  expect(f.ops.state().renewalsRemaining).toBe(0);
  await expect(f.ops.triggerClockDiscontinuity()).rejects.toThrow("stimulus_consumed");
});

test("a device-ended lease is journaled with its reason and close never restores over it", async () => {
  // Arrange
  const f = fixture();
  await running(f);
  f.endLease("lease_expired");
  // Act
  await f.ops.close();
  // Assert
  expect(f.calls.slice(-2)).toEqual(["status", "close:tab_closed"]);
  expect(f.ops.state().journal.entries.map(entry => [entry.event, entry.category])).toContainEqual(["device_baseline_observed", "lease_expired"]);
});

test.each([
  ["pause", "pause"], ["cancel", "cancel"], ["restoreChallengeSatisfied", "restore:challenge_satisfied"],
] as const)("%s ends the lease through the controller once", async (operation, call) => {
  // Arrange
  const f = fixture();
  await running(f);
  // Act
  await f.ops[operation]();
  // Assert
  expect(f.calls.at(-1)).toBe(call);
  expect(f.ops.state().leaseActive).toBeFalse();
  expect(f.ops.state().journal.entries.some(entry => entry.event === "device_baseline_observed")).toBeFalse();
});

test("a replayed Start rejected by the device reports only its closed category", async () => {
  // Arrange
  const f = fixture();
  await f.ops.connect();
  f.failStart(rejection("authentication_failed"));
  // Act
  const outcome = await f.ops.replayArtifact();
  // Assert
  expect(outcome).toEqual({ operation: "start", outcome: "rejected", category: "authentication_failed" });
  expect(f.calls.slice(-2)).toEqual(["start", "close:control_failed"]);
  expect(f.ops.state()).toMatchObject({ connected: false, leaseActive: false, status: "replay_rejected" });
});

test("a replayed renewal rejected by the device reports its closed category", async () => {
  // Arrange
  const f = fixture({ "/replay-artifact": { operation: "renew", renewal } });
  await running(f);
  await f.ops.renewOnce();
  f.failRenew(rejection("authentication_failed"));
  // Act
  const outcome = await f.ops.replayArtifact();
  // Assert
  expect(outcome).toEqual({ operation: "renew", outcome: "rejected", category: "authentication_failed" });
});

test("a local transport failure is reported as failed, never as a device rejection", async () => {
  // Arrange
  const f = fixture();
  await f.ops.connect();
  f.failStart(serialFailure("timeout"));
  // Act
  const outcome = await f.ops.replayArtifact();
  // Assert
  expect(outcome).toEqual({ operation: "start", outcome: "failed", category: "timeout" });
});

test("a replay is refused before the controller when its operation does not fit the lease state", async () => {
  // Arrange
  const f = fixture({ "/replay-artifact": { operation: "renew", renewal } });
  await f.ops.connect();
  // Act / Assert
  await expect(f.ops.replayArtifact()).rejects.toThrow("replay_admission");
  expect(f.calls).not.toContain("renew");
});

test("the rejection review leaves only high-water comparisons, never the digest", async () => {
  // Arrange
  const f = fixture();
  await f.ops.connect();
  // Act
  const review = await f.ops.authorizationRejectionReview();
  // Assert
  expect(review.highWater).toEqual({ advancedThisBoot: false, fingerprintMatchesLatestObservation: true, fingerprintFirstObservedEpoch: 1 });
  expect(JSON.stringify(review)).not.toContain("2".repeat(64));
});

test("physical-window hooks relay only a closed checkpoint token", async () => {
  // Arrange
  const f = fixture();
  await running(f);
  // Act
  const begun = await f.ops.beginPhysicalWindow();
  // Assert
  expect(begun).toEqual({ checkpoint: "armed" });
  expect(f.posted.at(-1)).toEqual({ path: "/physical-window", body: { event: "begin" } });
});

test("a physical-window answer outside the closed token form is refused", async () => {
  // Arrange
  const f = fixture({ "/physical-window": { checkpoint: "Restore power now!" } });
  await running(f);
  // Act / Assert
  await expect(f.ops.beginPhysicalWindow()).rejects.toThrow("physical_window_state");
});

test("completion reviews, closes and flushes before submitting the judgement", async () => {
  // Arrange
  const f = fixture();
  await f.ops.connect();
  // Act
  const receipt = await f.ops.submitCompletion();
  // Assert
  expect(receipt).toEqual({ result: "passed", scenario: "completion", cleanup_confirmed: true });
  expect(f.calls.slice(2)).toEqual(["/completion-context", "stimulus_review", "rejection_review", "close:tab_closed", "flush", "/completion-review"]);
});

test("the published state and journal never carry authorization, lease, challenge or pool values", async () => {
  // Arrange
  const f = fixture();
  await running(f);
  await f.ops.renewOnce();
  await f.ops.triggerClockDiscontinuity();
  f.endLease("monotonic_reset");
  await f.ops.statusReview();
  // Act
  const published = JSON.stringify(f.ops.state());
  // Assert
  for (const value of [secret, "lease_secret_id", "challenge_secret_id", "pool-user-secret", "pool-password-secret", "B".repeat(43), "2".repeat(64)]) expect(published).not.toContain(value);
  expect(f.ops.state().device).toEqual({ state: "baseline", restoration: "confirmed", reason: "monotonic_reset" });
});

test("a transport loss marks the page disconnected and the lease ended", async () => {
  // Arrange
  const f = fixture();
  await running(f);
  // Act
  await f.disconnect();
  // Assert
  expect(f.ops.state()).toMatchObject({ connected: false, leaseActive: false, status: "disconnected" });
  await expect(f.ops.renewOnce()).rejects.toThrow("controller_not_connected");
});

test("the physical window can be re-armed while the device is disconnected", async () => {
  // Arrange
  const f = fixture();
  await running(f);
  await f.disconnect();
  // Act
  const armed = await f.ops.armPhysicalWindow();
  // Assert
  expect(armed).toEqual({ checkpoint: "armed" });
  expect(f.posted.at(-1)).toEqual({ path: "/physical-window", body: { event: "arm" } });
});

test("the journal accepts only closed category tokens", () => {
  // Arrange
  const journal = new WorkerRestorationJournal();
  // Act
  journal.record("replay_rejected", "authentication_failed");
  // Assert
  expect(journal.values().entries).toEqual([{ ordinal: 1, event: "replay_rejected", category: "authentication_failed" }]);
  expect(() => journal.record("replay_rejected", "eyJhbGciOiJFZERTQSJ9.payload")).toThrow("journal_category_invalid");
});

test("the latest admission diagnostic appears in state without budget fields", async () => {
  // Arrange
  const f = fixture();
  await f.ops.connect();
  // Act
  f.ops.observeDiagnostic(diagnostic(admissionLine("preparation", "none", 31)));
  // Assert
  expect(f.ops.state().admission).toEqual({ stage: "preparation", firstFailure: "none", readiness: 31 });
});

test("admission is null before any observation", () => {
  // Arrange / Act / Assert
  expect(fixture().ops.state().admission).toBeNull();
});

test("the journal records admission only when its first failure changes", async () => {
  // Arrange
  const f = fixture();
  await f.ops.connect();
  // Act
  for (const [stage, failure] of [["admission", "none"], ["readiness", "none"], ["preparation", "none"], ["cleanup", "preparation"], ["complete", "preparation"]])
    f.ops.observeDiagnostic(diagnostic(admissionLine(stage!, failure!)));
  // Assert
  expect(f.ops.state().journal.entries.filter(entry => entry.event === "admission_observed").map(entry => entry.category)).toEqual(["none", "preparation"]);
  expect(f.ops.state().admission).toEqual({ stage: "complete", firstFailure: "preparation", readiness: 7 });
});

test("admissionDiagnostic returns the latest observation without a device command", async () => {
  // Arrange
  const f = fixture();
  await f.ops.connect();
  f.ops.observeDiagnostic(diagnostic(admissionLine("pool_activation", "pool_activation")));
  const before = f.calls.length;
  // Act
  const result = await f.ops.admissionDiagnostic();
  // Assert
  expect(result).toEqual({ admission: { stage: "pool_activation", firstFailure: "pool_activation", readiness: 7 } });
  expect(f.calls.length).toBe(before);
});

test("an admission failure observation never ends or blocks the page lease", async () => {
  // Arrange
  const f = fixture();
  await running(f);
  // Act
  f.ops.observeDiagnostic(diagnostic(admissionLine("cleanup", "preparation")));
  await f.ops.renewOnce();
  // Assert
  expect(f.ops.state()).toMatchObject({ leaseActive: true, status: "running" });
});

test("outside restoration mode admission diagnostics are ignored", () => {
  // Arrange
  const f = fixture({}, false);
  // Act
  f.ops.observeDiagnostic(diagnostic(admissionLine("cleanup", "preparation")));
  // Assert
  expect(f.ops.state().admission).toBeNull();
  expect(f.ops.state().journal.entries).toEqual([]);
});

const preservation = (identity: string, maybePool?: boolean) => ({ schema: maybePool === undefined ? "worker-preservation-v1" : "worker-preservation-v2",
  settings_sha256: "1".repeat(64), authorization_high_water_sha256: "2".repeat(64), device_identity_sha256: identity, mine_on_boot: false,
  ...(maybePool === undefined ? {} : { pool_configuration_unchanged_since_boot: maybePool }) }) as never;

test("identity and pool trackers are null before any preservation status", () => {
  // Arrange / Act
  const state = fixture().ops.state();
  // Assert
  expect([state.deviceIdentity, state.poolConfiguration]).toEqual([null, null]);
});

test("preservation observations publish only identity epochs and pool booleans", () => {
  // Arrange
  const f = fixture();
  // Act
  for (const value of [preservation("3".repeat(64)), preservation("3".repeat(64), true), preservation("3".repeat(64), true)]) f.ops.observePreservation(value);
  // Assert
  expect(f.ops.state()).toMatchObject({ deviceIdentity: { epoch: 1, observations: 3 }, poolConfiguration: { observations: 2, changed: false } });
  expect(JSON.stringify(f.ops.state())).not.toContain("3".repeat(64));
  expect(f.ops.state().journal.entries).toEqual([]);
});

test("a new identity and a changed pool configuration are journaled as closed events", () => {
  // Arrange
  const f = fixture();
  // Act
  for (const value of [preservation("3".repeat(64), true), preservation("4".repeat(64), false), preservation("4".repeat(64), false)]) f.ops.observePreservation(value);
  // Assert
  expect(f.ops.state().journal.entries.map(entry => [entry.event, entry.category])).toEqual([["device_identity_changed", undefined], ["pool_configuration_changed", undefined]]);
  expect(f.ops.state()).toMatchObject({ deviceIdentity: { epoch: 2, observations: 3 }, poolConfiguration: { observations: 3, changed: true } });
});

test("outside restoration mode preservation observations are ignored", () => {
  // Arrange
  const f = fixture({}, false);
  // Act
  f.ops.observePreservation(preservation("3".repeat(64), false));
  // Assert
  expect([f.ops.state().deviceIdentity, f.ops.state().poolConfiguration, f.ops.state().journal.entries]).toEqual([null, null, []]);
});
