import { expect, test } from "bun:test";
import { maybeWorkerDiagnosticPayload, maybeWorkerSerialDiagnostic } from "./worker-serial-diagnostics";
import { WorkerSerialFramer, encodeWorkerSerialEnvelope, WORKER_SERIAL_PROFILE } from "./worker-serial";

const startup = "usb_startup schema=v1 stage=network state=entered first_failure=none uptime_ms=123 redacted=true";
test("fragmented startup observations do not become protocol admission frames", () => {
  // Arrange
  const observations: unknown[] = [];
  const framer = new WorkerSerialFramer(value => observations.push(value));
  const bytes = new TextEncoder().encode(`arbitrary boot output\r\n${startup}\n`);
  // Act
  const frames = [...framer.push(bytes.slice(0, 50)), ...framer.push(bytes.slice(50))];
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

test("control payload text is never routed into diagnostic observations", () => {
  // Arrange
  const observations: unknown[] = [];
  const framer = new WorkerSerialFramer(value => observations.push(value));
  const frame = encodeWorkerSerialEnvelope({ profile: WORKER_SERIAL_PROFILE, kind: "control", sessionId: "AAAAAAAAAAAAAAAAAAAAAA", sequence: 1, payload: { line: startup } });
  // Act
  const frames = framer.push(frame);
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
