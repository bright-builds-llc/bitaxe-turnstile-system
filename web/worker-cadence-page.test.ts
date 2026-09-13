import { expect, test } from "bun:test";
import { createWorkerCadencePageOperations } from "./worker-cadence-page";
import { WorkerCadenceAcceptance } from "./worker-cadence-acceptance";
import { cadenceFixture } from "./worker-telemetry-cadence.fixture";

function fixture() {
  const cadence = new WorkerCadenceAcceptance(); cadence.configure(true);
  let published = 0, invalidated = 0, endpointCalls = 0;
  const input = { cadence, running: () => false, loaded: () => false, maybeReviewedBinding: (): string | undefined => "private-binding",
    invalidateAuthorization: () => { invalidated += 1; }, publish: () => { published += 1; },
    local: async () => { throw new Error("no local request expected"); },
    controller: () => ({
      telemetryCadenceArm: async (phase: "idle" | "usb" | "mining") => ({ schema: "worker-telemetry-cadence-arm-v1" as const, phase, armedAtUs: 1, generation: 7 }),
      telemetryCadenceReview: async () => cadenceFixture(),
      telemetryCadenceEndpoint: async () => { endpointCalls += 1; return { schema: "worker-telemetry-endpoint-v1" as const, ipv4: "192.0.2.10", httpPort: 80, observedAtUs: 1, bootOrdinal: 1, generation: 7, controlSessionBindingSha256: "private-binding" }; },
      transportProbe: async () => ({ paddingBytes: 65376, requestPayloadBytes: 65536, responsePayloadBytes: 65536 }),
    }),
  };
  return { input, counts: () => ({ published, invalidated, endpointCalls }) };
}
test("private endpoint bypasses public state and clears any stale authorization context", async () => {
  const f = fixture(); const page = createWorkerCadencePageOperations(f.input);
  const endpoint = await page.cadenceEndpoint();
  expect(endpoint.ipv4).toBe("192.0.2.10");
  expect(f.counts()).toEqual({ published: 0, invalidated: 1, endpointCalls: 1 });
  expect(JSON.stringify(f.input.cadence.state())).not.toContain(endpoint.ipv4);
  expect(JSON.stringify(f.input.cadence.state())).not.toContain(endpoint.controlSessionBindingSha256);
});
test("loaded allowance rejects endpoint before a possession or network operation", async () => {
  const f = fixture(); f.input.loaded = () => true;
  await expect(createWorkerCadencePageOperations(f.input).cadenceEndpoint()).rejects.toThrow("cadence_admission");
  expect(f.counts()).toEqual({ published: 0, invalidated: 0, endpointCalls: 0 });
});

test("endpoint without a reviewed proof fails before any controller request", async () => {
  const f = fixture(); f.input.maybeReviewedBinding = () => undefined;
  await expect(createWorkerCadencePageOperations(f.input).cadenceEndpoint()).rejects.toThrow("cadence_endpoint_possession_required");
  expect(f.counts().endpointCalls).toBe(0);
});
