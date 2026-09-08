import { expect, test } from "bun:test";
import { diagnosticInitialWorkCaptured } from "./worker-diagnostic-work";
import { expectedMiningFilter, type WorkerMiningProgress } from "./worker-mining-progress";
import { progressFixture } from "./worker-mining-progress.fixture";

function progress(matches: string, misses: string): WorkerMiningProgress {
  return { ...progressFixture, schema: "worker-mining-progress-v2", expected_filter: expectedMiningFilter,
    expected_filter_matches: matches, expected_filter_misses: misses };
}
test("first dispatch alone does not finish a filter diagnostic", () => {
  // Arrange
  const qualification = { generation: 7, work_dispatched: 1, mining_progress: progress("0", "0") };
  // Act / Assert
  expect(diagnosticInitialWorkCaptured(qualification)).toBeFalse();
  expect(diagnosticInitialWorkCaptured({ generation: 7, work_dispatched: 1 })).toBeFalse();
});
test("either filter result completes initial-work collection without a share", () => {
  // Arrange
  for (const mining_progress of [progress("1", "0"), progress("0", "1")]) {
    // Act / Assert
    expect(diagnosticInitialWorkCaptured({ generation: 7, work_dispatched: 1, mining_progress })).toBeTrue();
  }
});
test("stale-generation observations cannot finish a new diagnostic", () => {
  // Arrange
  const mining_progress = progress("1", "0");
  // Act / Assert
  expect(diagnosticInitialWorkCaptured({ generation: 8, work_dispatched: 1, mining_progress })).toBeFalse();
  expect(diagnosticInitialWorkCaptured({ generation: 7, work_dispatched: 0, mining_progress })).toBeFalse();
});
test("explicit v1 observations preserve their initial-dispatch stop behavior", () => {
  expect(diagnosticInitialWorkCaptured({ generation: 7, work_dispatched: 1,
    mining_progress: { ...progressFixture, schema: "worker-mining-progress-v1" } })).toBeTrue();
});
