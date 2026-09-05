import { expect, test } from "bun:test";
import fixture from "../conformance/bwg-0.1/headless-work-consent-vectors.json";
import { connectWebSerialHeadlessClient } from "./headless-client";
import {
  headlessInput,
  transportHarness,
} from "./headless-client.test-support";
import { serialHarness } from "./worker-serial.test-support";
import type { WorkerLeaseAuthorizationContext } from "./worker-lease-authorization";

test("public serial headless entrypoint binds real Authority Start/Renew to production possession", async () => {
  // Arrange
  const h = await serialHarness(fixture.challenge.challengeId);
  const authority = transportHarness();
  const transport = {
    ...authority.transport,
    async start(_receipt?: string, context?: WorkerLeaseAuthorizationContext) {
      if (!context) throw new Error("missing possession");
      authority.calls.push("start");
      return h.grant(context);
    },
    async renewWorkerLease(context?: WorkerLeaseAuthorizationContext) {
      if (!context) throw new Error("missing renew context");
      return h.renewal(context);
    },
  };
  const client = await connectWebSerialHeadlessClient({
    client: await headlessInput(transport),
    worker: h.input,
  });
  await client.grantConsent();
  // Act
  await client.start();
  await client.renewWorkerLease();
  await client.pause();
  await client.close();
  // Assert
  expect(
    h.received.filter((frame) => frame.command === "start_lease").length,
  ).toBe(1);
  expect(
    h.received.filter((frame) => frame.command === "renew_lease").length,
  ).toBe(1);
  expect(authority.calls).toEqual(["start", "pause"]);
  expect(h.counts()).toMatchObject({ closed: 1, locked: false, active: false });
});
