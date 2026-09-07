import { describe, expect, test } from "bun:test";
import { parseWorkerMiningProgress } from "./worker-mining-progress";
import { progressFixture } from "./worker-mining-progress.fixture";
describe("closed mining progress", () => {
  test("keeps below-target nonces distinct from qualified candidates", () => {
    // Arrange / Act
    const value = parseWorkerMiningProgress(progressFixture, 7);
    // Assert
    expect(value.poll_nonce).toBe("7"); expect(value.below_pool_target).toBe("7");
    expect(value.qualified_candidates).toBe("0"); expect(value.observed_at_ms).toBe("18446744073709551615");
  });
  test("rejects arbitrary private fields at every object boundary", () => {
    // Arrange
    for (const value of [ { ...progressFixture, private_payload: "synthetic" },
      { ...progressFixture, discards: { ...progressFixture.discards, private_payload: "synthetic" } },
      { ...progressFixture, blocked: { ...progressFixture.blocked, private_payload: "synthetic" } } ]) {
      // Act / Assert
      expect(() => parseWorkerMiningProgress(value, 7)).toThrow();
    }
  });
  test("rejects unsafe, noncanonical or wrong-generation values", () => {
    // Arrange
    for (const value of ["01", "-1", "1.2", "18446744073709551616", 7, null]) {
      // Act / Assert
      expect(() => parseWorkerMiningProgress({ ...progressFixture, poll_nonce: value }, 7)).toThrow();
    }
    expect(() => parseWorkerMiningProgress(progressFixture, 8)).toThrow();
    expect(() => parseWorkerMiningProgress({ ...progressFixture, generation: 0 }, 0)).toThrow();
  });
});
