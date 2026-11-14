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

async function miningSerialClient() {
  const h = await serialHarness(fixture.challenge.challengeId);
  const authority = transportHarness();
  const transport = {
    ...authority.transport,
    async start(_receipt?: string, context?: WorkerLeaseAuthorizationContext) {
      if (!context) throw new Error("missing possession");
      return h.grant(context);
    },
  };
  const client = await connectWebSerialHeadlessClient({
    client: await headlessInput(transport),
    worker: h.input,
  });
  await client.grantConsent();
  await client.start();
  return { h, authority, client };
}

test("a confirmed Cancel restoration closes the USB port", async () => {
  // Arrange
  const { h, client } = await miningSerialClient();

  // Act
  await client.cancel();

  // Assert
  expect(h.counts()).toMatchObject({ closed: 1, locked: false, active: false });
});

test("a confirmed expiry restoration closes the USB port", async () => {
  // Arrange
  const { h, authority } = await miningSerialClient();

  // Act
  await authority.emitAuthority({ type: "challenge_lifecycle", state: "expired" });

  // Assert
  expect(h.counts()).toMatchObject({ closed: 1, locked: false, active: false });
});

test("the Authority's report of a confirmed Cancel sends nothing to the released port", async () => {
  // Arrange
  const { h, authority, client } = await miningSerialClient();
  await client.cancel();
  const commandsBefore = h.received.filter((frame) => frame.command).length;

  // Act
  const report = authority.emitAuthority({ type: "challenge_lifecycle", state: "cancelled" });

  // Assert
  await expect(report).resolves.toBeUndefined();
  expect(h.received.filter((frame) => frame.command).length).toBe(commandsBefore);
});

test("a completed challenge keeps the USB port until the client closes", async () => {
  // Arrange
  const { h, authority } = await miningSerialClient();

  // Act
  await authority.emitAuthority({ type: "challenge_lifecycle", state: "satisfied" });

  // Assert
  expect(h.counts()).toMatchObject({ closed: 0, active: false });
});
