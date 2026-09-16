import { expect, test } from "bun:test";
import { parseNoiseStartInput, parseNoiseStatus } from "./worker-noise-diagnostic";
import { noiseInput, noiseIdle, noiseAccepted } from "./worker-noise-diagnostic.fixture";

test("Noise parses isolated closed idle and accepted observations", () => {
  const source = noiseAccepted();
  const parsed = parseNoiseStatus(source);
  source.job.stages[0]!.durationUs = 99;
  expect(parsed.job?.stages[0]?.durationUs).toBe(500);
  expect(parseNoiseStatus(noiseIdle())).toEqual(noiseIdle());
  expect(parseNoiseStartInput(noiseInput)).toEqual(noiseInput);
});
test.each([
  { authorityPublicKey: undefined }, { authorityPublicKey: "A".repeat(42) + "B" }, { authorityPublicKey: "A".repeat(42) },
  { attemptId: "A".repeat(21) + "B" }, { expectedBootOrdinal: 0 }, { networkObservedAtUs: Number.MAX_SAFE_INTEGER + 1 },
  { fixtureIpv4: "localhost" }, { fixtureIpv4: "127.0.0.1" }, { fixtureIpv4: "192.168.001.2" }, { fixtureIpv4: "8.8.8.8" }, { fixtureIpv4: "192.168.0.256" },
  { fixturePort: 0 }, { fixturePort: 65536 }, { password: "secret" }, { schema: "noise" },
])("Noise start rejects malformed/private extra inputs before dispatch", change => {
  expect(() => parseNoiseStartInput({ ...noiseInput, ...change })).toThrow();
});
test.each(["10.0.0.1", "172.16.0.1", "172.31.255.254", "192.168.0.1"])("Noise admits literal private address %s", fixtureIpv4 => {
  expect(parseNoiseStartInput({ ...noiseInput, fixtureIpv4 }).fixtureIpv4).toBe(fixtureIpv4);
});
test.each([
  { state: "idle" }, { state: "running" }, { rawLog: "private" }, { job: null },
  { observation: { ...noiseIdle().observation, ssid: "private" } },
  { observation: { ...noiseIdle().observation, bootOrdinal: 2 } },
  { observation: { ...noiseIdle().observation, wifiConnected: false } },
])("Noise status rejects contradictory states and extra network metadata", change => {
  expect(() => parseNoiseStatus({ ...noiseAccepted(), ...change })).toThrow();
});
test.each([
  { inputSha256: "A".repeat(64) }, { authorityDeadlineUs: 120001001 }, { localSocketPort: null },
  { stages: [] }, { stages: [...noiseAccepted().job.stages, noiseAccepted().job.stages[0]] },
  { firstFailure: { stage: "proof_written", category: "proof", detail: "extra", atUs: 5000 } },
  { terminal: { outcome: "accepted", decidedAtUs: null } },
  { resources: { ...noiseAccepted().job.resources, workerState: "running" } },
  { resources: { ...noiseAccepted().job.resources, deadlineMet: false } },
  { resources: { ...noiseAccepted().job.resources, volatileInputsDisposed: false } },
  { resources: { ...noiseAccepted().job.resources, extra: true } },
])("Noise accepted result requires complete cleanup and bounded evidence", change => {
  const source = noiseAccepted();
  expect(() => parseNoiseStatus({ ...source, job: { ...source.job, ...change } })).toThrow();
});
test.each([
  { stage: "tcp_connected" }, { sequence: 2 }, { atUs: null }, { atUs: -1 }, { atUs: 120_002_000 }, { durationUs: null }, { durationUs: 60_000_001 }, { bytes: 0 }, { extra: "private" },
])("Noise stage rejects reorder, null success, deadline and invalid count", change => {
  const source = noiseAccepted();
  const changed = { ...source, job: { ...source.job, stages: [{ ...source.job.stages[0], ...change }, ...source.job.stages.slice(1)] } };
  expect(() => parseNoiseStatus(changed)).toThrow();
});
test("Noise requires peer-sized exact act-two and proof byte counts", () => {
  for (const index of [2, 3, 5]) {
    const source = noiseAccepted(); source.job.stages[index]!.bytes!++;
    expect(() => parseNoiseStatus(source)).toThrow();
  }
});
test("retained terminal preserves original generation across fresh-session review", () => {
  const source = noiseAccepted(); source.observation.transportEpoch++; source.observation.workerGeneration++;
  expect(parseNoiseStatus(source).job?.workerGeneration).toBe(7);
});

test("connected station without a DHCP address is typed missing endpoint evidence", () => {
  const source = noiseIdle(); source.observation.stationIpv4 = null;
  expect(parseNoiseStatus(source).observation.stationIpv4).toBeNull();
});
test("ordinary running observations cannot omit measured timing or change current generation", () => {
  const accepted = noiseAccepted();
  const running = { ...accepted, state: "running", job: { ...accepted.job, terminal: null } };
  expect(() => parseNoiseStatus({ ...running, job: { ...running.job, workerGeneration: 8 } })).toThrow();
  expect(() => parseNoiseStatus({ ...running, job: { ...running.job, stages: [{ ...running.job.stages[0], atUs: null }] } })).toThrow();
  expect(() => parseNoiseStatus({ ...running, observation: { ...running.observation, observedAtUs: 2000 } })).toThrow();
});
test("nonaccepted terminal needs earliest cause, corresponding outcome and actual cleanup", () => {
  const source = noiseAccepted();
  const firstFailure = { stage: "proof_written", category: "proof", detail: "malformed", atUs: 7000 };
  const rejected = { ...source, job: { ...source.job, firstFailure, terminal: { outcome: "rejected", decidedAtUs: 10000 } } };
  expect(parseNoiseStatus(rejected).job?.terminal?.outcome).toBe("rejected");
  for (const outcome of ["expired", "cancelled", "incomplete"]) expect(() => parseNoiseStatus({ ...rejected, job: { ...rejected.job, terminal: { ...rejected.job.terminal, outcome } } })).toThrow();
});
test("stage durations cannot overlap prior protocol operations", () => {
  const source = noiseAccepted(); source.job.stages[2]!.durationUs = 1500;
  expect(() => parseNoiseStatus(source)).toThrow("noise_operation_order");
});

test("clock failure retains unavailable cleanup timing without manufacturing success", () => {
  const source = noiseAccepted();
  source.observation.observedAtUs = 0;
  source.job.firstFailure = { stage: "cleanup", category: "clock_invalid", detail: "clock_discontinuity", atUs: null };
  source.job.terminal = { outcome: "incomplete", decidedAtUs: null };
  source.job.resources = { socketState: "closed", workerState: "quiescent", volatileInputsDisposed: true,
    startedAtUs: null, deadlineAtUs: null, releasedAtUs: null, deadlineMet: false, failure: source.job.firstFailure };
  for (const index of [6, 7]) { source.job.stages[index]!.atUs = null; source.job.stages[index]!.durationUs = null; }
  expect(parseNoiseStatus(source).job?.terminal?.outcome).toBe("incomplete");
  source.job.terminal.outcome = "accepted";
  expect(() => parseNoiseStatus(source)).toThrow();
});

test.each(["rejected", "expired"] as const)("transport timeout permits %s pending independent deadline judgment", outcome => {
  const source = noiseAccepted();
  source.job.firstFailure = { stage: "proof_written", category: "write", detail: "timeout", atUs: 7000 };
  source.job.terminal = { outcome, decidedAtUs: 10000 };
  expect(parseNoiseStatus(source).job?.terminal?.outcome).toBe(outcome);
});
test("authority deadline timeout requires expired outcome", () => {
  const source = noiseAccepted();
  source.job.firstFailure = { stage: "proof_written", category: "authority_lost", detail: "timeout", atUs: 7000 };
  source.job.terminal = { outcome: "rejected", decidedAtUs: 10000 };
  expect(() => parseNoiseStatus(source)).toThrow("noise_terminal_cause");
  source.job.terminal.outcome = "expired";
  expect(parseNoiseStatus(source).job?.terminal?.outcome).toBe("expired");
});

test("one snapshot cannot contain protocol progress after its earliest failure", () => {
  const source = noiseAccepted();
  source.job.firstFailure = { stage: "tcp_connected", category: "connect", detail: "io", atUs: 3000 };
  source.job.terminal = { outcome: "rejected", decidedAtUs: 10000 };
  expect(() => parseNoiseStatus(source)).toThrow("noise_progress_after_failure");
});
