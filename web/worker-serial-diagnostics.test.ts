import { expect, test } from "bun:test";
import { maybeWorkerDiagnosticPayload, maybeWorkerSerialDiagnostic, WorkerSerialDiagnosticHistory } from "./worker-serial-diagnostics";
import { WorkerSerialFramer, encodeWorkerSerialEnvelope, WORKER_SERIAL_PROFILE } from "./worker-serial";
import { serialHarness } from "./worker-serial.test-support";
import { createWebSerialWorkerController, workerSerialQualificationHook, type WorkerSerialQualificationHook } from "./webserial-worker-controller";

test("revoked-session raw controller rejection survives subsequent liveness loss", async () => {
  // Arrange
  const harness = await serialHarness();
  const history = new WorkerSerialDiagnosticHistory();
  const failures: string[] = [];
  const hook: WorkerSerialQualificationHook = {
    suppressHeartbeats: false,
    maybeObserveDiagnostic: value => history.observe(value),
    maybeObserveSerialFailure: category => failures.push(category),
  };
  const input = { ...harness.input, [workerSerialQualificationHook]: hook };
  const controller = createWebSerialWorkerController(input);
  await controller.requestPermission();
  harness.dropHeartbeats();
  // Act: the firmware writer emits plain text after epoch revocation.
  harness.receiveRaw(new TextEncoder().encode("session_"));
  harness.receiveRaw(new TextEncoder().encode("failed\ninvalid_transition\nsynthetic-secret\n"));
  await harness.advance(2800);
  // Assert: diagnostics neither admit a response nor extend heartbeat authority.
  expect(history.values()).toEqual([{ category: "control_failure", authoritative: false, error: "session_failed" }]);
  expect(failures).toContain("liveness_lost");
  expect(harness.counts()).toMatchObject({ closed: 1, locked: false, active: false });
});

const startup = "usb_startup schema=v1 stage=network state=entered first_failure=none uptime_ms=123 redacted=true";
// Producer: bitaxe-worker-control/src/controller.rs, WorkerControlError::category.
const controlErrors = ["invalid_frame", "invalid_request", "admission_required", "invalid_proof", "authentication_failed", "invalid_transition", "persistence_failed", "monotonic_reset", "session_failed", "restoration_pending", "stale_response", "encoding_failed"];

test.each(controlErrors)("controller rejection %s is a non-authoritative closed observation", error => {
  // Arrange / Act
  const observed = maybeWorkerDiagnosticPayload({ line: error });
  // Assert
  expect(observed).toEqual({ category: "control_failure", authoritative: false, error });
});

test("controller diagnostics reject unknown categories and attached text", () => {
  // Arrange
  const lines = ["unknown_error", "bwg_worker event=restoration_pending", ...controlErrors.flatMap(error => [error + " secret=synthetic", "synthetic " + error, error + "\n", error + "\r", error + "\u2028"])];
  // Act / Assert
  for (const line of lines) expect(maybeWorkerSerialDiagnostic(line)).toBeUndefined();
  expect(maybeWorkerDiagnosticPayload({ line: "session_failed", authoritative: true })).toBeUndefined();
});

test("diagnostic history retains the first failure of each category", () => {
  // Arrange
  const history = new WorkerSerialDiagnosticHistory();
  const first = { category: "control_failure", authoritative: false, error: "session_failed" };
  // Act
  history.observe(first);
  history.observe({ category: "control_failure", authoritative: false, error: "invalid_transition" });
  history.observe({ category: "serial_rx_failure", authoritative: false, stage: "heartbeat_timeout" });
  history.observe({ category: "serial_rx_failure", authoritative: false, stage: "session_revoked" });
  // Assert
  expect(history.values()).toEqual([first, { category: "serial_rx_failure", authoritative: false, stage: "heartbeat_timeout" }]);
});

test("diagnostic history clears earlier failures for a fresh connection", () => {
  // Arrange
  const history = new WorkerSerialDiagnosticHistory();
  history.observe({ category: "control_failure", authoritative: false, error: "session_failed" });
  // Act
  history.clear();
  history.observe({ category: "control_failure", authoritative: false, error: "authentication_failed" });
  // Assert
  expect(history.values()).toEqual([{ category: "control_failure", authoritative: false, error: "authentication_failed" }]);
});

test("diagnostic history updates ordinary observations without exceeding its bound", () => {
  // Arrange
  const history = new WorkerSerialDiagnosticHistory();
  for (let stage = 0; stage < 32; stage++) history.observe({ category: "startup", stage, state: "entered" });
  // Act
  history.observe({ category: "startup", stage: 0, state: "complete" });
  history.observe({ category: "startup", stage: 32, state: "entered" });
  // Assert
  expect(history.values()).toHaveLength(32);
  expect(history.values()[0]?.state).toBe("complete");
});
test("fragmented startup observations do not become protocol admission frames", async () => {
  // Arrange
  const observations: unknown[] = [];
  const framer = new WorkerSerialFramer(value => observations.push(value));
  const bytes = new TextEncoder().encode(`arbitrary boot output\r\n${startup}\n`);
  // Act
  const frames = [...await framer.push(bytes.slice(0, 50)), ...await framer.push(bytes.slice(50))];
  // Assert
  expect(frames).toEqual([]);
  expect(observations).toEqual([{ category: "startup", authoritative: false, stage: "network", state: "entered", first_failure: "none", uptime_ms: 123 }]);
});

test("diagnostics reject raw secrets, unknown fields, impossible counters, and arbitrary stage text", () => {
  // Arrange / Act / Assert
  for (const line of ["ssid=private", `${startup} password=private`, startup.replace("stage=network", "stage=private"), startup.replace("uptime_ms=123", "uptime_ms=9999999999999999"), startup.replace("state=entered", "state=failed")]) {
    expect(maybeWorkerSerialDiagnostic(line)).toBeUndefined();
  }
  expect(maybeWorkerDiagnosticPayload({ line: startup, request: { poolPassword: "synthetic" } })).toBeUndefined();
  expect(maybeWorkerDiagnosticPayload({ line: startup })?.category).toBe("startup");
});

test("control payload text is never routed into diagnostic observations", async () => {
  // Arrange
  const observations: unknown[] = [];
  const framer = new WorkerSerialFramer(value => observations.push(value));
  const frame = await encodeWorkerSerialEnvelope({ profile: WORKER_SERIAL_PROFILE, kind: "control", sessionId: "AAAAAAAAAAAAAAAAAAAAAA", sequence: 1, payload: { line: startup } });
  // Act
  const frames = await framer.push(frame);
  // Assert
  expect(frames).toHaveLength(1);
  expect(observations).toEqual([]);
});

test("code identity and allocation metadata remain closed non-authoritative observations", () => {
  // Arrange / Act / Assert
  const lines = [
    `usb_runtime_identity schema=v1 firmware_commit=${"a".repeat(40)} app_elf_sha256=${"b".repeat(64)} redacted=true`,
    "usb_reboot_discriminator schema=v1 boot_ordinal=2 reset_reason=software_cpu uptime_ms=40 redacted=true",
    "allocation_failure_context schema=v1 requested_bytes=84 capabilities=00000804 source_hash=0011223344556677 stage=network redacted=true",
    "rust_panic_receipt schema=v1 file_hash=11223344 line=9 redacted=true",
  ];
  for (const line of lines) expect(maybeWorkerSerialDiagnostic(line)?.authoritative).toBeFalse();
});


test("receive and storage diagnostics retain closed stages without arbitrary error text", () => {
  // Arrange
  const lines = [
    "usb_rx_failure schema=v1 stage=heartbeat_timeout observed_bytes=4096 redacted=true",
    "storage_http_failure schema=v1 phase=http_server error=no_memory redacted=true",
    "storage_http_status schema=v1 spiffs_available=true http_ready=false redacted=true",
  ];
  // Act / Assert
  for (const line of lines) {
    expect(maybeWorkerSerialDiagnostic(line)?.authoritative).toBeFalse();
    expect(maybeWorkerSerialDiagnostic(`${line} secret=synthetic`)).toBeUndefined();
  }
  expect(maybeWorkerSerialDiagnostic(lines[0]!.replace("4096", "66561"))).toBeUndefined();
  expect(maybeWorkerSerialDiagnostic(lines[1]!.replace("no_memory", "synthetic-secret"))).toBeUndefined();
});
