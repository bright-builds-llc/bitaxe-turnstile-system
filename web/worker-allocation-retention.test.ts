import { expect, test } from "bun:test";
import { maybeWorkerSerialDiagnostic, WorkerSerialDiagnosticHistory } from "./worker-serial-diagnostics";
import { parseWorkerDiagnosticExport } from "./worker-diagnostic-export";
function diagnostic(line: string) {
  const value = maybeWorkerSerialDiagnostic(line);
  if (!value) throw new Error("invalid synthetic diagnostic fixture");
  return value;
}
function saturatedHistory() {
  const history = new WorkerSerialDiagnosticHistory();
  for (const stage of ["early_identity", "usb_install", "nvs", "hardware", "worker_recovery", "runtime_services", "storage_http", "network", "worker_control", "statistics", "runtime_ready"]) history.observe(diagnostic(`usb_startup schema=v1 stage=${stage} state=entered first_failure=none uptime_ms=1 redacted=true`));
  for (const stage of ["idle", "admission", "readiness", "preparation", "pool_activation", "active", "cleanup", "complete"]) history.observe(diagnostic(`worker_admission schema=v1 stage=${stage} first_failure=none readiness=0 budget_reserved_ms=0 budget_complete=false redacted=true`));
  for (const stage of ["worker_owner_prepare", "usb_install", "usb_installed", "statistics_start", "statistics_started", "wifi_driver_prepare", "wifi_driver_prepared"]) history.observe(diagnostic(`usb_memory_checkpoint stage=${stage} free_bytes=100 largest_block_bytes=100 reserve_bytes=1 redacted=true`));
  for (const line of [
    "usb_reboot_discriminator schema=v1 boot_ordinal=1 reset_reason=power_on uptime_ms=1 redacted=true",
    `usb_runtime_identity schema=v1 firmware_commit=${"a".repeat(40)} app_elf_sha256=${"b".repeat(64)} redacted=true`,
    "storage_http_status schema=v1 spiffs_available=true http_ready=true redacted=true",
    "session_failed",
    "usb_tx_failure schema=v1 stage=write elapsed_ms=1 queued_bytes=0 record_bytes=10 redacted=true",
    "usb_rx_failure schema=v1 stage=read observed_bytes=0 redacted=true",
  ]) history.observe(diagnostic(line));
  expect(history.values()).toHaveLength(32);
  return history;
}
const allocation = diagnostic("allocation_failure_receipt schema=v1 requested_bytes=852 capabilities=0000080c redacted=true");
const context = diagnostic("allocation_failure_context schema=v1 requested_bytes=852 capabilities=0000080c source_hash=0123456789abcdef stage=hardware redacted=true");

test("allocation failure and context survive normal saturation and reconnect", () => {
  // Arrange
  const history = saturatedHistory();
  // Act
  history.observe(allocation);
  history.observe(context);
  // Assert
  expect(history.values()).toContainEqual(allocation);
  expect(history.values()).toContainEqual(context);
  expect(parseWorkerDiagnosticExport({ schema: "worker-diagnostic-export-v1", observations: history.values() }).observations).toHaveLength(34);
  history.clear();
  expect(history.values()).toEqual([allocation, context]);
});

test("allocation crash keys deduplicate stable receipts without exceeding the export bound", () => {
  // Arrange
  const history = saturatedHistory();
  // Act
  for (let bytes = 1; bytes <= 20; bytes++) history.observe(diagnostic(`allocation_failure_receipt schema=v1 requested_bytes=${bytes} capabilities=0000080c redacted=true`));
  history.observe(diagnostic("allocation_failure_receipt schema=v1 requested_bytes=1 capabilities=0000080c redacted=true"));
  // Assert
  expect(history.values()).toHaveLength(40);
  expect(parseWorkerDiagnosticExport({ schema: "worker-diagnostic-export-v1", observations: history.values() }).observations).toHaveLength(40);
  history.clear();
  expect(history.values()).toHaveLength(8);
});
