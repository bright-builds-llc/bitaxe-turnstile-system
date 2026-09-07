import { expect, test } from "bun:test";
import { parseWorkerOwnerResources, requireWorkerOwnerHeadroom } from "./worker-owner-resources";
import { parseWorkerLeaseGrant } from "./worker-controller";
import vectors from "../conformance/bwg-worker-controller-0.4/qualification-attempt-vectors.json";
const resource = { schema: "worker-owner-resources-v1", generation: 1, phase: "active", observed_at_ms: "18446744073709551615", heap_free_bytes: 8000, heap_largest_bytes: 6000, stack_free_bytes: 4096 };

test("owner resource parser preserves exact u64 timestamps and rejects wrong generation or extras", () => {
  expect(parseWorkerOwnerResources(resource, 1).observed_at_ms).toBe(resource.observed_at_ms);
  for (const invalid of [{ ...resource, phase: ["active"] }, { ...resource, generation: 2 }, { ...resource, observed_at_ms: "18446744073709551616" }, { ...resource, observed_at_ms: "01" }, { ...resource, stack_free_bytes: 4294967296 }, { ...resource, private: "secret" }]) expect(() => parseWorkerOwnerResources(invalid, 1)).toThrow();
});
test("iterative headroom enforcement rejects absent resource evidence while legacy stays unchanged", () => {
  const grant = parseWorkerLeaseGrant(vectors.vectors[0]!.grant);
  expect(() => requireWorkerOwnerHeadroom(grant, undefined)).toThrow("window_control_failed");
  const { qualificationAttempt: _attempt, ...legacy } = grant;
  expect(() => requireWorkerOwnerHeadroom(legacy, undefined)).not.toThrow();
});
