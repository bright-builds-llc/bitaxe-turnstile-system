import { expect, test } from "bun:test";
import { serialHarness } from "./worker-serial.test-support";

async function activeLease() {
  const h = await serialHarness();
  await h.controller.requestPermission();
  const context = await h.controller.prepareWorkerLeaseAuthorizationContext("start");
  await h.controller.startLease(await h.grant(context));
  return { h, context };
}

test.each(["lease_expired", "monotonic_reset", "control_failed", "connectivity_lost"])("close keeps a device-ended lease's stored %s reason", async reason => {
  // Arrange
  const { h } = await activeLease();
  h.expireWork(reason);
  const observed = await h.controller.status();
  const before = h.received.length;
  // Act
  await h.controller.close();
  // Assert
  expect(observed.restoration).toEqual({ status: "confirmed", reason } as never);
  expect(h.received.slice(before).map(value => value.command ?? value.kind)).not.toContain("restore");
});

test("close still restores a lease the device has not ended", async () => {
  // Arrange
  const { h } = await activeLease();
  await h.controller.status();
  const before = h.received.length;
  // Act
  await h.controller.close();
  // Assert
  expect(h.received.slice(before).map(value => value.command)).toContain("restore");
});

test("a renewal is refused locally once status shows the device ended the lease", async () => {
  // Arrange
  const { h, context } = await activeLease();
  const renewal = await h.renewal(context);
  h.expireWork("lease_expired");
  await h.controller.status();
  const before = h.received.length;
  // Act / Assert
  await expect(h.controller.renewLease(renewal)).rejects.toThrow();
  expect(h.received.length).toBe(before);
  await h.controller.close();
});
