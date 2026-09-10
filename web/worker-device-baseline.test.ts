import { expect, test } from "bun:test";
import { workerDeviceBaselineConfirmed } from "./worker-device-baseline";

test.each(["confirmed", "not_required"])("baseline accepts restoration %s", restoration => {
  // Arrange
  const observed = { state: "baseline", restoration: { status: restoration } };
  // Act
  const confirmed = workerDeviceBaselineConfirmed(observed);
  // Assert
  expect(confirmed).toBeTrue();
});

test.each(["pending", "failed", "unknown", undefined, null])("baseline rejects restoration %s", restoration => {
  // Arrange
  const observed = { state: "baseline", restoration: { status: restoration } };
  // Act
  const confirmed = workerDeviceBaselineConfirmed(observed);
  // Assert
  expect(confirmed).toBeFalse();
});

test.each([undefined, null, {}, { state: "baseline" }, { state: "baseline", restoration: null }])(
  "missing status or restoration never confirms baseline: %j", observed => {
    expect(workerDeviceBaselineConfirmed(observed)).toBeFalse();
  },
);

test.each(["active", "restoring", "faulted", "unknown"])("%s is not a baseline even after restoration", state => {
  // Arrange
  const observed = { state, restoration: { status: "confirmed" } };
  // Act
  const confirmed = workerDeviceBaselineConfirmed(observed);
  // Assert
  expect(confirmed).toBeFalse();
});
