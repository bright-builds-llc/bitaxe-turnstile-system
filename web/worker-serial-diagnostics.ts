/** Local, non-authoritative observations; never identity or Work Lease admission. */
export type WorkerSerialDiagnostic = Readonly<Record<string, string | number | boolean>>;
const stages = "early_identity|usb_install|nvs|hardware|worker_recovery|runtime_services|storage_http|network|worker_control|statistics|runtime_ready";
const allocationStages = "early_identity|hardware|runtime_services|storage_http|network|usb_install|statistics|runtime_ready";
type Grammar = { category: string; pattern: RegExp; fields: readonly string[]; numeric: readonly string[] };
const grammars: readonly Grammar[] = [
  {
    category: "serial_tx_failure", pattern: /^usb_tx_failure schema=v1 stage=(write|write_timeout|flush_timeout) elapsed_ms=(\d{1,10}) queued_bytes=(\d{1,5}) record_bytes=(\d{1,5}) redacted=true$/u,
    fields: ["stage", "elapsed_ms", "queued_bytes", "record_bytes"], numeric: ["elapsed_ms", "queued_bytes", "record_bytes"]
  },
  {
    category: "network_failure",
    pattern: /^wifi_startup_failure schema=v1 phase=(netif|event_loop|driver|ap_configuration|station_configuration|driver_start|ap_netif|station_netif|captive_dns|owner_install|reconnect_subscription|reconnect_spawn) error=(no_memory|invalid_state|timeout|driver_error|io_error|owner_error) redacted=true$/u,
    fields: ["phase", "error"], numeric: [],
  },
  {
    category: "startup",
    pattern: new RegExp(`^usb_startup schema=v1 stage=(${stages}) state=(entered|failed|complete) first_failure=(none|${stages}) uptime_ms=(\\d{1,16}) redacted=true$`, "u"),
    fields: ["stage", "state", "first_failure", "uptime_ms"],
    numeric: ["uptime_ms"],
  },
  {
    category: "runtime_identity",
    pattern: /^usb_runtime_identity schema=v1 firmware_commit=([0-9a-f]{40}) app_elf_sha256=([0-9a-f]{64}) redacted=true$/u,
    fields: ["firmware_commit", "app_elf_sha256"],
    numeric: [],
  },
  {
    category: "boot",
    pattern: /^usb_reboot_discriminator schema=v1 boot_ordinal=(\d{1,16}) reset_reason=(power_on|software_cpu|watchdog|panic|brownout|other) uptime_ms=(\d{1,16}) redacted=true$/u,
    fields: ["boot_ordinal", "reset_reason", "uptime_ms"],
    numeric: ["boot_ordinal", "uptime_ms"],
  },
  {
    category: "memory",
    pattern: /^usb_memory_checkpoint stage=(worker_owner_prepare|usb_install|usb_installed|statistics_start|statistics_started|wifi_driver_prepare|wifi_driver_prepared) free_bytes=(\d{1,10}) largest_block_bytes=(\d{1,10}) reserve_bytes=(\d{1,10}) redacted=true$/u,
    fields: ["stage", "free_bytes", "largest_block_bytes", "reserve_bytes"],
    numeric: ["free_bytes", "largest_block_bytes", "reserve_bytes"],
  },
  {
    category: "startup_failure",
    pattern: /^bwg_worker_start_failure category=startup_failed detail=(owner_spawn|usb_install|control_owner) redacted=true$/u,
    fields: ["detail"],
    numeric: [],
  },
  {
    category: "allocation_failure",
    pattern: /^allocation_failure_receipt schema=v1 requested_bytes=(\d{1,10}) capabilities=([0-9a-f]{8}) redacted=true$/u,
    fields: ["requested_bytes", "capabilities"],
    numeric: ["requested_bytes"],
  },
  {
    category: "allocation_context",
    pattern: new RegExp(`^allocation_failure_context schema=v1 requested_bytes=(\\d{1,10}) capabilities=([0-9a-f]{8}) source_hash=([0-9a-f]{16}) stage=(${allocationStages}) redacted=true$`, "u"),
    fields: ["requested_bytes", "capabilities", "source_hash", "stage"],
    numeric: ["requested_bytes"],
  },
  {
    category: "panic",
    pattern: /^rust_panic_receipt schema=v1 file_hash=([0-9a-f]{8}) line=(\d{1,10}) redacted=true$/u,
    fields: ["file_hash", "line"],
    numeric: ["line"],
  },
];

/** Parses only producer-owned closed grammars; arbitrary boot/log/request text is dropped. */
export function maybeWorkerSerialDiagnostic(line: string): WorkerSerialDiagnostic | undefined {
  if (line.length > 1024) return undefined;
  for (const grammar of grammars) {
    const match = grammar.pattern.exec(line);
    if (!match) continue;
    const value: Record<string, string | number | boolean> = { category: grammar.category, authoritative: false };
    for (const [index, key] of grammar.fields.entries()) {
      const text = match[index + 1]; if (text === undefined) return undefined;
      const field = grammar.numeric.includes(key) ? Number(text) : text;
      if (typeof field === "number" && (!Number.isSafeInteger(field) || field < 0)) return undefined;
      if (typeof field === "number" && !["uptime_ms", "boot_ordinal"].includes(key) && field > 0xffffffff) return undefined;
      value[key] = field;
    }
    if (value.boot_ordinal === 0 || value.requested_bytes === 0 || value.line === 0) return undefined;
    if (value.state === "failed" && value.first_failure === "none") return undefined;
    if (typeof value.record_bytes === "number" && (value.record_bytes > 66560 || Number(value.queued_bytes) > value.record_bytes)) return undefined;
    return Object.freeze(value);
  }
  return undefined;
}

export function maybeWorkerDiagnosticPayload(payload: Record<string, unknown>) {
  if (Object.keys(payload).length !== 1 || typeof payload.line !== "string") return undefined;
  return maybeWorkerSerialDiagnostic(payload.line);
}
