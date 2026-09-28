export type RestartFixtureMode = "same_stream" | "queued_prior_boot" | "reopen_once" | "reopen_complete" | "reopen_twice" | "missing_boot";
export function restartBootBytes(bootOrdinal: number, complete = true, readyBase = 1000, resetReason: "software_cpu" | "panic" = "software_cpu", identity = { firmwareSourceCommit: "a".repeat(40), appElfSha256: "b".repeat(64) }): Uint8Array {
  return new TextEncoder().encode([
    `usb_reboot_discriminator schema=v1 boot_ordinal=${bootOrdinal} reset_reason=${resetReason} uptime_ms=50 redacted=true`,
    ...(complete ? [
      `usb_runtime_identity schema=v1 firmware_commit=${identity.firmwareSourceCommit} app_elf_sha256=${identity.appElfSha256} redacted=true`,
      `usb_startup schema=v1 stage=runtime_ready state=complete first_failure=none uptime_ms=${readyBase} redacted=true`,
      `usb_startup schema=v1 stage=runtime_ready state=complete first_failure=none uptime_ms=${readyBase + 500} redacted=true`,
    ] : []),
    "",
  ].join("\n"));
}
