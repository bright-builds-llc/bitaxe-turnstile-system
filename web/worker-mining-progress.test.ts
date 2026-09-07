import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import schema from "../conformance/bwg-worker-controller-0.4/contract.schema.json";
import { expectedMiningFilter, parseWorkerMiningProgress, type WorkerMiningProgress } from "./worker-mining-progress";
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
  test("v2 distinguishes expected-filter misses without qualifying work", () => {
    // Arrange
    const input: WorkerMiningProgress = { ...progressFixture, schema: "worker-mining-progress-v2", expected_filter: expectedMiningFilter,
      expected_filter_matches: "0", expected_filter_misses: "7" };
    // Act
    const value = parseWorkerMiningProgress(input, 7);
    // Assert
    expect(value).toEqual(input);
    expect(value.qualified_candidates).toBe("0");
    expect(parseWorkerMiningProgress(progressFixture, 7).schema).toBe("worker-mining-progress-v1");
  });
  test("v2 rejects unsupported filters, raw data, and unbounded match counts", () => {
    // Arrange
    const input: WorkerMiningProgress = { ...progressFixture, schema: "worker-mining-progress-v2", expected_filter: expectedMiningFilter,
      expected_filter_matches: "0", expected_filter_misses: "7" };
    for (const mutation of [{ expected_filter: "arbitrary" }, { raw_nonce: "private" },
      { expected_filter_matches: "01" }, { expected_filter_misses: "18446744073709551616" },
      { schema: "worker-mining-progress-v1" }]) {
      // Act / Assert
      expect(() => parseWorkerMiningProgress({ ...input, ...mutation }, 7)).toThrow();
    }
  });
  test("published conformance accepts both closed versions and rejects cross-version fields", () => {
    // Arrange
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile({
      $schema: schema.$schema,
      $defs: { miningProgress: schema.$defs.miningProgress, miningProgressV1: schema.$defs.miningProgressV1,
        miningProgressV2: schema.$defs.miningProgressV2 },
      $ref: "#/$defs/miningProgress",
    });
    const current = { ...progressFixture, schema: "worker-mining-progress-v2", expected_filter: expectedMiningFilter,
      expected_filter_matches: "0", expected_filter_misses: "7" };
    // Act / Assert
    expect(validate(progressFixture)).toBeTrue();
    expect(validate(current)).toBeTrue();
    expect(validate({ ...current, schema: "worker-mining-progress-v1" })).toBeFalse();
    expect(validate({ ...current, expected_filter: "unqualified-model" })).toBeFalse();
    expect(validate({ ...current, raw_header: "private" })).toBeFalse();
  });
});
