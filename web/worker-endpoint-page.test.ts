import { expect, test } from "bun:test";
import trust from "../conformance/bwg-worker-deployment-trust-0.2/trust.json";
import { createWorkerEndpointPageOperations } from "./worker-endpoint-page";
import { parseWorkerSerialAcceptanceConfiguration, requireWorkerAcceptanceModeTransition } from "./worker-serial-acceptance-config";

const endpoint = {
  schema: "worker-telemetry-endpoint-v1" as const, ipv4: "192.0.2.10", httpPort: 80, observedAtUs: 5_000_000,
  bootOrdinal: 7, generation: 3,
};

function page(options: { enabled?: boolean; idle?: boolean; binding?: string; calls?: string[] } = {}) {
  const calls = options.calls ?? [];
  let invalidations = 0;
  const operations = createWorkerEndpointPageOperations({
    enabled: () => options.enabled ?? true, idle: () => options.idle ?? true,
    maybeController: () => ({
      prepareWorkerLeaseAuthorizationContext: async (operation) => { calls.push(`possess:${operation}`); return { controlSessionBindingSha256: "fresh" }; },
      telemetryCadenceEndpoint: async (binding) => { calls.push(`endpoint:${String(binding)}`); return { ...endpoint, controlSessionBindingSha256: options.binding ?? "fresh" }; },
    }),
    invalidateAuthorization: () => { invalidations += 1; },
  });
  return { operations, calls, invalidations: () => invalidations };
}

test("station endpoint is read with a fresh possession binding", async () => {
  // Arrange
  const subject = page();

  // Act
  const result = await subject.operations.observeStationEndpoint();

  // Assert
  expect(result.ipv4).toBe("192.0.2.10");
  expect(subject.calls).toEqual(["possess:start", "endpoint:fresh"]);
  expect(subject.invalidations()).toBe(2);
});

test("an unconfigured or busy page is refused before any controller call", async () => {
  // Arrange
  const calls: string[] = [];
  const unconfigured = page({ enabled: false, calls });
  const busy = page({ idle: false, calls });

  // Act / Assert
  await expect(unconfigured.operations.observeStationEndpoint()).rejects.toThrow("station_endpoint_admission");
  await expect(busy.operations.observeStationEndpoint()).rejects.toThrow("station_endpoint_admission");
  expect(calls).toEqual([]);
});

test("the endpoint can be observed once per page", async () => {
  // Arrange
  const subject = page();
  await subject.operations.observeStationEndpoint();

  // Act / Assert
  await expect(subject.operations.observeStationEndpoint()).rejects.toThrow("station_endpoint_admission");
});

test("an endpoint bound to another session is rejected", async () => {
  // Arrange
  const subject = page({ binding: "stale" });

  // Act / Assert
  await expect(subject.operations.observeStationEndpoint()).rejects.toThrow("station_endpoint_binding");
});

const base = { expectedGateCommit: "a".repeat(40), expectedFirmwareSourceCommit: "b".repeat(40), expectedAppElfSha256: "c".repeat(64), trust };

test("endpoint handoff configuration parses as its own exclusive mode", () => {
  // Act
  const parsed = parseWorkerSerialAcceptanceConfiguration({ ...base, stationEndpointHandoff: true }, "a".repeat(40));

  // Assert
  expect(parsed.stationEndpointHandoff).toBeTrue();
  expect(() => parseWorkerSerialAcceptanceConfiguration({ ...base, stationEndpointHandoff: true, cadenceQualification: true }, "a".repeat(40))).toThrow("configuration_invalid");
  expect(() => parseWorkerSerialAcceptanceConfiguration({ ...base, stationEndpointHandoff: false }, "a".repeat(40))).toThrow("configuration_invalid");
});

test("endpoint handoff mode cannot be added to or removed from a configured page", () => {
  // Arrange
  const plain = parseWorkerSerialAcceptanceConfiguration(base, "a".repeat(40));
  const handoff = parseWorkerSerialAcceptanceConfiguration({ ...base, stationEndpointHandoff: true }, "a".repeat(40));

  // Act / Assert
  expect(() => requireWorkerAcceptanceModeTransition(plain, handoff)).toThrow("station_endpoint_mode_changed");
  expect(() => requireWorkerAcceptanceModeTransition(handoff, plain)).toThrow("station_endpoint_mode_changed");
  expect(() => requireWorkerAcceptanceModeTransition(undefined, handoff)).not.toThrow();
});
