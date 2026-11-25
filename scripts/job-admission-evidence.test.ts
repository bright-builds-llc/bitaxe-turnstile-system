import { expect, test } from "bun:test";
import { joinJobAdmissions } from "./job-admission-evidence";

const dim = (text: string) => `\u001b[2m${text}\u001b[0m`;
const field = (name: string, value: string) => `\u001b[3m${name}\u001b[0m${dim("=")}${value}`;

function admission(jobId: bigint, outcome: "completed" | "failed"): string {
  const category = outcome === "completed" ? '"accepted"' : '"proposal_rejected"';
  const level = outcome === "completed" ? "\u001b[32m INFO\u001b[0m" : "\u001b[33m WARN\u001b[0m";
  return `${dim("2026-11-23T12:22:35.617201Z")} ${level} ${dim("p2poolv2_lib::stratum::server")}${dim(":")} Job admission ${outcome} ${field("category", category)} ${field("job_id", jobId.toString())} ${field("latency_milliseconds", "12")}`;
}

function relayed(jobId: bigint, at = "2026-11-23T12:22:35.700000Z"): string {
  return `${dim(at)} \u001b[32m INFO\u001b[0m ${dim("bwg_core::stratum_v1::tcp")}${dim(":")} Stratum job relayed ${field("job_id", jobId.toString(16))} ${field("clean_jobs", "true")}`;
}

const FIRST = 1795436356522489001n;
const SECOND = 1795436356522489002n;

test("every relayed job with an accepted admission passes", () => {
  // Arrange
  const input = { hydraLines: [admission(FIRST, "completed"), admission(SECOND, "completed")], adapterLines: [relayed(FIRST), relayed(SECOND)] };
  // Act
  const report = joinJobAdmissions(input);
  // Assert
  expect(report).toMatchObject({ relayed: 2, admitted: 2, unadmittedRelayed: 0, passed: true });
});

test("a relayed job with no admission fails", () => {
  // Arrange
  const input = { hydraLines: [admission(FIRST, "completed")], adapterLines: [relayed(FIRST), relayed(SECOND)] };
  // Act
  const report = joinJobAdmissions(input);
  // Assert
  expect(report).toMatchObject({ relayed: 2, unadmittedRelayed: 1, passed: false });
});

test("a relayed job whose only admission failed fails", () => {
  // Arrange
  const input = { hydraLines: [admission(FIRST, "failed")], adapterLines: [relayed(FIRST)] };
  // Act
  const report = joinJobAdmissions(input);
  // Assert
  expect(report).toMatchObject({ admitted: 0, failedAdmissions: 1, unadmittedRelayed: 1, passed: false });
});

test("job IDs that differ only beyond 2^53 stay distinct", () => {
  // Arrange: as doubles, these two IDs are the same number.
  expect(Number(FIRST)).toBe(Number(SECOND));
  const input = { hydraLines: [admission(FIRST, "completed")], adapterLines: [relayed(SECOND)] };
  // Act
  const report = joinJobAdmissions(input);
  // Assert
  expect(report).toMatchObject({ unadmittedRelayed: 1, passed: false });
});

test("a run that relayed no job fails", () => {
  // Arrange
  const input = { hydraLines: [admission(FIRST, "completed")], adapterLines: [] };
  // Act
  const report = joinJobAdmissions(input);
  // Assert
  expect(report).toMatchObject({ relayed: 0, passed: false });
});

test("an admitted job that was never relayed is counted and passes", () => {
  // Arrange: Hydra's stack checks its own difficulty on a connection of its own.
  const input = { hydraLines: [admission(FIRST, "completed"), admission(SECOND, "completed")], adapterLines: [relayed(SECOND)] };
  // Act
  const report = joinJobAdmissions(input);
  // Assert
  expect(report).toMatchObject({ relayed: 1, admitted: 2, admittedNotRelayed: 1, passed: true });
});

test("a relayed job ID that isn't hex fails as unadmitted", () => {
  // Arrange
  const notHex = relayed(FIRST).replace(FIRST.toString(16), "job-01");
  const input = { hydraLines: [admission(FIRST, "completed")], adapterLines: [notHex] };
  // Act
  const report = joinJobAdmissions(input);
  // Assert
  expect(report).toMatchObject({ relayed: 1, unadmittedRelayed: 1, passed: false });
});

test("the report names the first and last relay times", () => {
  // Arrange
  const input = {
    hydraLines: [admission(FIRST, "completed"), admission(SECOND, "completed")],
    adapterLines: [relayed(FIRST, "2026-11-23T12:22:35.700000Z"), relayed(SECOND, "2026-11-23T12:27:36.100000Z")],
  };
  // Act
  const report = joinJobAdmissions(input);
  // Assert
  expect(report).toMatchObject({ maybeFirstRelayedAt: "2026-11-23T12:22:35.700000Z", maybeLastRelayedAt: "2026-11-23T12:27:36.100000Z" });
});
