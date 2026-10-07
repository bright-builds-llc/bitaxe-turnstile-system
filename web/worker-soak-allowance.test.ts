import { expect, test } from "bun:test";
import trust from "../conformance/bwg-worker-deployment-trust-0.2/trust.json";
import { parseWorkerControllerStatus, parseWorkerLeaseGrant } from "./worker-controller";
import { AcceptanceRenewalProgress, maximumWindowRenewals, soakTickDecision, SOAK_BROWSER_BACKSTOP_MILLISECONDS } from "./worker-serial-acceptance-actions";
import { parseWorkerSerialAcceptanceConfiguration, requireWorkerAcceptanceModeTransition } from "./worker-serial-acceptance-config";
import { parseWorkerSoakLedger, SOAK_MAXIMUM_ACTIVE_MILLISECONDS } from "./worker-soak-allowance";

const soakAllowance = { schema: "worker-soak-allowance-v1", id: "AwMDAwMDAwMDAwMDAwMDAw", ordinal: 1, maximumActiveMilliseconds: 619050 };
const v1 = { protocolVersion: "bwg-worker-controller/0.4", leaseId: "lease", challengeId: "challenge", authorization: "synthetic",
  durationMilliseconds: 60000, renewAfterMilliseconds: 20000, stratum: { endpoint: "stratum+tcp://192.168.1.3:3333/", username: "synthetic", password: "x" } };
const soak = { ...v1, hardwareProfile: "upstream-default", soakAllowance };

test("an upstream-default soak grant parses with its profile and allowance", () => {
  // Arrange / Act
  const grant = parseWorkerLeaseGrant(soak);
  // Assert
  expect([grant.hardwareProfile, grant.soakAllowance?.maximumActiveMilliseconds]).toEqual(["upstream-default", SOAK_MAXIMUM_ACTIVE_MILLISECONDS]);
});

test.each([
  ["upstream-default without a soak", { ...v1, hardwareProfile: "upstream-default" }],
  ["a soak without a stated profile", { ...v1, soakAllowance }],
  ["a soak with a short lease", { ...soak, durationMilliseconds: 30000 }],
  ["a soak with a fast renewal", { ...soak, renewAfterMilliseconds: 5000 }],
  ["a soak short of the shutdown tail", { ...soak, soakAllowance: { ...soakAllowance, maximumActiveMilliseconds: 600000 } }],
  ["an unknown profile", { ...soak, hardwareProfile: "overclock" }],
  ["a soak combined with a qualification attempt", { ...soak, qualificationAttempt: { schema: "worker-qualification-attempt-v1", id: "AQEBAQEBAQEBAQEBAQEBAQ", ordinal: 1, purpose: "normal", maximumActiveMilliseconds: 180000 } }],
])("the Gate refuses %s before delivery", (_name, input) => {
  // Arrange / Act / Assert
  expect(() => parseWorkerLeaseGrant(input)).toThrow();
});

test("a grant without the new fields is unchanged", () => {
  // Arrange / Act
  const grant = parseWorkerLeaseGrant(v1);
  // Assert
  expect("hardwareProfile" in grant || "soakAllowance" in grant).toBeFalse();
});

test("the soak ledger total must equal its charged ordinals", () => {
  // Arrange
  const ledger = { schema: "worker-soak-ledger-v1", next_ordinal: 2, total_charged_ms: 619050, pending: false, last_completed_ordinal: 1 };
  // Act / Assert
  expect(parseWorkerSoakLedger(ledger).next_ordinal).toBe(2);
  expect(() => parseWorkerSoakLedger({ ...ledger, total_charged_ms: 600000 })).toThrow();
});

test("status admits a soak observation and its larger reservation, but not with a qualification attempt", () => {
  // Arrange
  const qualification = { schema: "worker-qualification-v1", revocation_reason: "none", active_limit_ms: 619050, shutdown_budget_ms: 15550,
    work_gate_remaining_ms: 500000, generation: 1, active_ms: 100000, generation_elapsed_ms: 101000, budget_reserved_ms: 619050, budget_complete: false,
    submitted: 0, accepted: 0, rejected: 0, nonce_work_correlations: 0, work_dispatched: 0, last_valid_heartbeat_ms: 0, gate_closed_ms: null,
    shutdown_started_ms: null, safe_stop_stage: "not_started", safe_stop_complete: false, voltage_volts: null, power_watts: null, chip_temp_celsius: null,
    fan_rpm: null, voltage_fresh: false, power_fresh: false, temperature_fresh: false, fan_fresh: false, watchdog_alive: true, mine_on_boot: false,
    soak: { schema: "worker-soak-observation-v1", ordinal: 1, maximum_active_ms: 619050, reserved_ms: 619050, complete: false, active_ms: 100000 } };
  const status = { protocolVersion: "bwg-worker-controller/0.4", state: "baseline", monotonicMilliseconds: 100, restoration: { status: "confirmed", reason: "paused" } };
  // Act
  const parsed = parseWorkerControllerStatus({ ...status, qualification });
  // Assert
  expect(parsed.qualification?.soak?.active_ms).toBe(100000);
  const { soak: _soak, ...withoutSoak } = qualification;
  expect(() => parseWorkerControllerStatus({ ...status, qualification: withoutSoak })).toThrow();
});

test("only soak leases may carry more than sixteen renewals", () => {
  // Arrange / Act
  const limits = [maximumWindowRenewals(parseWorkerLeaseGrant(soak)), maximumWindowRenewals(parseWorkerLeaseGrant(v1))];
  // Assert
  expect(limits).toEqual([36, 16]);
});

test("renewal progress enforces the limit chosen for its window", async () => {
  // Arrange
  const progress = new AcceptanceRenewalProgress();
  progress.beginWindow(2);
  const controller = { renewLease: async () => ({}) } as never;
  await progress.renew(controller, {} as never);
  await progress.renew(controller, {} as never);
  // Act / Assert
  await expect(progress.renew(controller, {} as never)).rejects.toThrow("acceptance_renewal_bound");
});

const open = { revocation_reason: "none", work_gate_remaining_ms: 300000, safe_stop_complete: false, active_ms: 300000 } as const;
test("a soak renews only while the device's work gate is open and the renewal is due", () => {
  // Arrange / Act
  const decisions = [soakTickDecision({ browserElapsedMs: 1000, nowMs: 5000, nextRenewMs: 4000, maybeQualification: open }),
    soakTickDecision({ browserElapsedMs: 1000, nowMs: 3000, nextRenewMs: 4000, maybeQualification: open })];
  // Assert
  expect(decisions).toEqual(["renew", "continue"]);
});

test("after the device closes the gate the soak never renews and stops only after safe-stop", () => {
  // Arrange
  const closed = { revocation_reason: "lease_or_budget_expired", work_gate_remaining_ms: 0, safe_stop_complete: false, active_ms: 600010 } as const;
  // Act
  const decisions = [soakTickDecision({ browserElapsedMs: 601000, nowMs: 9e9, nextRenewMs: 0, maybeQualification: closed }),
    soakTickDecision({ browserElapsedMs: 615000, nowMs: 9e9, nextRenewMs: 0, maybeQualification: { ...closed, safe_stop_complete: true } })];
  // Assert
  expect(decisions).toEqual(["await_safe_stop", "stop"]);
});

test("browser time alone never stops a soak before its backstop, and the backstop fails it", () => {
  // Arrange / Act
  const decisions = [soakTickDecision({ browserElapsedMs: 619050, nowMs: 0, nextRenewMs: 1, maybeQualification: open }),
    soakTickDecision({ browserElapsedMs: SOAK_BROWSER_BACKSTOP_MILLISECONDS, nowMs: 0, nextRenewMs: 1, maybeQualification: open })];
  // Assert
  expect(decisions).toEqual(["continue", "fail"]);
});

test("any other revocation fails the soak", () => {
  // Arrange / Act
  const decision = soakTickDecision({ browserElapsedMs: 1000, nowMs: 0, nextRenewMs: 1, maybeQualification: { ...open, revocation_reason: "unsafe_observation" } });
  // Assert
  expect(decision).toBe("fail");
});

const base = { expectedGateCommit: "a".repeat(40), expectedFirmwareSourceCommit: "b".repeat(40), expectedAppElfSha256: "c".repeat(64), trust };
test("soak mode is explicit, exclusive and sticky", () => {
  // Arrange
  const config = parseWorkerSerialAcceptanceConfiguration({ ...base, soakQualification: true }, base.expectedGateCommit);
  // Act / Assert
  expect(config.soakQualification).toBeTrue();
  for (const change of [{ soakQualification: false }, { soakQualification: true, cadenceQualification: true }, { soakQualification: true, stationEndpointHandoff: true }, { soakQualification: true, recoveryPhase: "loss" }])
    expect(() => parseWorkerSerialAcceptanceConfiguration({ ...base, ...change }, base.expectedGateCommit)).toThrow();
  expect(() => requireWorkerAcceptanceModeTransition(config, parseWorkerSerialAcceptanceConfiguration(base, base.expectedGateCommit))).toThrow("soak_mode_changed");
});

test("no renewal is sent within the last five seconds before the device closes its gate", () => {
  // Arrange / Act
  const decision = soakTickDecision({ browserElapsedMs: 600000, nowMs: 9e9, nextRenewMs: 0, maybeQualification: { ...open, work_gate_remaining_ms: 4000 } });
  // Assert
  expect(decision).toBe("continue");
});

test("a completed safe-stop ends the soak even after the browser backstop", () => {
  // Arrange
  const done = { revocation_reason: "lease_or_budget_expired", work_gate_remaining_ms: 0, safe_stop_complete: true, active_ms: 600010 } as const;
  // Act
  const decision = soakTickDecision({ browserElapsedMs: SOAK_BROWSER_BACKSTOP_MILLISECONDS + 1, nowMs: 0, nextRenewMs: 1, maybeQualification: done });
  // Assert
  expect(decision).toBe("stop");
});

test("a lease expiry before 600 s of work fails the soak instead of ending it normally", () => {
  // Arrange
  const expired = { revocation_reason: "lease_or_budget_expired", work_gate_remaining_ms: 0, safe_stop_complete: true, active_ms: 250000 } as const;
  // Act
  const decision = soakTickDecision({ browserElapsedMs: 300000, nowMs: 0, nextRenewMs: 1, maybeQualification: expired });
  // Assert
  expect(decision).toBe("fail");
});
