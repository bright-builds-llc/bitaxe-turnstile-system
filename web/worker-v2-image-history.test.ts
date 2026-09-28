import { expect, test } from "bun:test";
import { WorkerV2ImageHistory } from "./worker-v2-image-history";
import { WorkerPreservationBaseline } from "./worker-preservation";
import { v2Accepted, v2Idle } from "./worker-v2-serial.fixture";
const before = { phase: "before" as const, firmwareSourceCommit: "a".repeat(40), appElfSha256: "b".repeat(64) };
const candidate = { phase: "candidate" as const, firmwareSourceCommit: "c".repeat(40), appElfSha256: "d".repeat(64) };
function setup() {
  const history = new WorkerV2ImageHistory(), preservation = new WorkerPreservationBaseline();
  preservation.observe({ schema: "worker-preservation-v1", settings_sha256: "1".repeat(64), authorization_high_water_sha256: "2".repeat(64), device_identity_sha256: "3".repeat(64), mine_on_boot: false });
  const status = v2Accepted(); history.observe(status, before, preservation.maybePublicState());
  const idle = v2Idle(); idle.observation.bootOrdinal = 2;
  return { history, status, idle, baseline: preservation.maybePublicState()! };
}
test.each(["source_only", "elf_only", "missing_preservation", "authorization", "identity", "mine_on_boot", "candidate_record"])("planned transition rejects incomplete evidence: %s", scenario => {
  // Arrange
  const { history, idle, baseline } = setup();
  const image = { ...candidate };
  if (scenario === "source_only") image.appElfSha256 = before.appElfSha256;
  if (scenario === "elf_only") image.firmwareSourceCommit = before.firmwareSourceCommit;
  if (scenario === "authorization") baseline.authorization_high_water_match = false;
  if (scenario === "identity") baseline.device_identity_match = false;
  if (scenario === "mine_on_boot") baseline.mine_on_boot = true;
  const status = scenario === "candidate_record" ? v2Accepted() : idle;
  // Act / Assert
  expect(() => history.observe(status, image, scenario === "missing_preservation" ? undefined : baseline)).toThrow("v2_retained_evidence");
});
test("caller mutation cannot rewrite retained before-image evidence", () => {
  // Arrange
  const { history, status, baseline } = setup(); status.record.jobCommitment = "e".repeat(64);
  // Act / Assert
  expect(() => history.observe(status, before, baseline)).toThrow("v2_retained_evidence");
});
test("candidate history still rejects terminal mutation and disappearance", () => {
  // Arrange
  const { history, idle, baseline } = setup(); history.observe(idle, candidate, baseline);
  const terminal = v2Accepted(); terminal.observation.bootOrdinal = terminal.record.bootOrdinal = 2; terminal.connection!.bootOrdinal = 2;
  history.observe(terminal, candidate, baseline);
  // Act / Assert
  terminal.record.jobCommitment = "e".repeat(64);
  expect(() => history.observe(terminal, candidate, baseline)).toThrow("v2_retained_evidence");
  expect(() => history.observe(idle, candidate, baseline)).toThrow("v2_retained_evidence");
});
test("candidate idle observations cannot roll back after a later boot", () => {
  // Arrange
  const { history, idle, baseline } = setup(); history.observe(idle, candidate, baseline);
  idle.observation.bootOrdinal = 3; history.observe(idle, candidate, baseline);
  // Act / Assert
  idle.observation.bootOrdinal = 2;
  expect(() => history.observe(idle, candidate, baseline)).toThrow("v2_retained_evidence");
});
test("an idle before image still requires a strictly newer candidate boot", () => {
  // Arrange
  const { baseline } = setup(), history = new WorkerV2ImageHistory(), idle = v2Idle();
  history.observe(idle, before, baseline);
  // Act / Assert
  expect(() => history.observe(idle, candidate, baseline)).toThrow("v2_retained_evidence");
});
