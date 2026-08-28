import { describe, expect, test } from "bun:test";

import controllerFixtures from "../conformance/bwg-worker-controller-0.3/fixtures.json";
import type { WorkerContinuityStore } from "./worker-continuity-store";
import type {
  WorkerControllerCapabilitiesV03,
  WorkerLeaseGrantV03,
} from "./worker-controller-v03";
import {
  deviceCommands,
  makeDevice,
  memoryContinuityStore,
  restoredDevice,
  testController,
  waitFor,
  webUsbHarness,
} from "./webusb-worker-controller-v03-test-harness";

describe("WebUSB Worker Controller 0.3 permission and admission", () => {
  test("rejects permission outside a direct user gesture before requesting a device", async () => {
    // Arrange
    const harness = webUsbHarness();
    const controller = testController({
      usb: harness.usb,
      deviceFilter: { vendorId: 0x1209, productId: 0xb17a },
      trustedUpdateKeys: controllerFixtures.updateAuthorityKeys,
      userActivation: () => false,
    });

    // Act
    const permission = controller.requestPermission();

    // Assert
    await expect(permission).rejects.toThrow("direct user gesture");
    expect(harness.requestCount()).toBe(0);
    expect(harness.writeCount()).toBe(0);
  });

  test("rejects the evidence or wrong control function before writing", async () => {
    // Arrange
    const harness = webUsbHarness({ controlSubclassCode: 2 });
    const controller = testController({
      usb: harness.usb,
      deviceFilter: { vendorId: 0x1209, productId: 0xb17a },
      trustedUpdateKeys: controllerFixtures.updateAuthorityKeys,
      userActivation: () => true,
    });

    // Act
    const permission = controller.requestPermission();

    // Assert
    await expect(permission).rejects.toThrow("application descriptor is invalid");
    expect(harness.requestCount()).toBe(1);
    expect(harness.writeCount()).toBe(0);
  });

  test("admits signed Reference Firmware before sending a Work Lease", async () => {
    // Arrange
    const harness = webUsbHarness();
    const controller = testController({
      usb: harness.usb,
      deviceFilter: { vendorId: 0x1209, productId: 0xb17a },
      trustedUpdateKeys: controllerFixtures.updateAuthorityKeys,
      userActivation: () => true,
    });

    // Act
    const connection = await controller.requestPermission();
    const status = await controller.startLease(
      controllerFixtures.lease as WorkerLeaseGrantV03,
    );

    // Assert
    expect(connection).toMatchObject({ mode: "initial", baselineRestoration: "not_required" });
    expect(await controller.discover()).toEqual(
      controllerFixtures.capabilities as WorkerControllerCapabilitiesV03,
    );
    expect(status.state).toBe("mining");
    expect(harness.commands()).toEqual(["discover", "prove_possession", "start_lease"]);
    expect(JSON.stringify(await controller.discover())).not.toMatch(/serial|fixture-worker-01/i);
  });

  test("does not require a cloneable USB serial after Device Identity possession succeeds", async () => {
    // Arrange
    const device = makeDevice();
    const harness = webUsbHarness({ devices: [device] });
    const controller = testController({
      usb: harness.usb,
      deviceFilter: { vendorId: 0x1209, productId: 0xb17a },
      trustedUpdateKeys: controllerFixtures.updateAuthorityKeys,
      userActivation: () => true,
    });

    // Act
    const connection = await controller.requestPermission();

    // Assert
    expect(connection.mode).toBe("initial");
  });

  test("durably reacquires the same Device Identity after a tab-local controller is replaced", async () => {
    // Arrange
    const store = memoryContinuityStore();
    const first = makeDevice("cloneable-serial");
    const restored = restoredDevice("different-cloneable-serial");
    const harness = webUsbHarness({ devices: [first, restored] });
    const initialController = testController({
      usb: harness.usb,
      deviceFilter: { vendorId: 0x1209, productId: 0xb17a },
      trustedUpdateKeys: controllerFixtures.updateAuthorityKeys,
      userActivation: () => true,
      continuityStore: store,
    });
    const initial = await initialController.requestPermission();
    harness.disconnect(first);
    const restoredController = testController({
      usb: harness.usb,
      deviceFilter: { vendorId: 0x1209, productId: 0xb17a },
      trustedUpdateKeys: controllerFixtures.updateAuthorityKeys,
      userActivation: () => true,
      continuityStore: store,
    });

    // Act
    const recovered = await restoredController.requestPermission();

    // Assert
    expect(initial.mode).toBe("initial");
    expect(recovered).toMatchObject({
      mode: "recovered",
      baselineRestoration: "confirmed",
    });
    expect(JSON.stringify(recovered)).not.toMatch(/serial|fingerprint|jwk/i);
  });

  test("terminal cancellation clears durable Device Identity continuity", async () => {
    // Arrange
    const store = memoryContinuityStore();
    const harness = webUsbHarness({
      devices: [makeDevice("fixture-worker-01"), makeDevice("fixture-worker-01")],
    });
    const first = testController({
      usb: harness.usb,
      deviceFilter: { vendorId: 0x1209, productId: 0xb17a },
      trustedUpdateKeys: controllerFixtures.updateAuthorityKeys,
      userActivation: () => true,
      continuityStore: store,
    });
    await first.requestPermission();
    await first.cancel();
    const next = testController({
      usb: harness.usb,
      deviceFilter: { vendorId: 0x1209, productId: 0xb17a },
      trustedUpdateKeys: controllerFixtures.updateAuthorityKeys,
      userActivation: () => true,
      continuityStore: store,
    });

    // Act
    const connection = await next.requestPermission();

    // Assert
    expect(connection.mode).toBe("initial");
  });

  test("retains continuity when cancellation does not confirm the exact terminal baseline", async () => {
    // Arrange
    const store = memoryContinuityStore();
    const first = makeDevice("fixture-worker-01", {
      maybeResultByCommand: {
        cancel: {
          protocolVersion: "bwg-worker-controller/0.3",
          state: "baseline",
          monotonicMilliseconds: 10,
          restoration: { status: "confirmed", reason: "paused" },
        },
      },
    });
    const restored = restoredDevice("fixture-worker-01");
    const harness = webUsbHarness({ devices: [first, restored] });
    const controller = testController({
      usb: harness.usb,
      deviceFilter: { vendorId: 0x1209, productId: 0xb17a },
      trustedUpdateKeys: controllerFixtures.updateAuthorityKeys,
      userActivation: () => true,
      continuityStore: store,
    });
    await controller.requestPermission();

    // Act
    const cancellation = controller.cancel();

    // Assert
    await expect(cancellation).rejects.toThrow("restoration is unconfirmed");
    const recovered = testController({
      usb: harness.usb,
      deviceFilter: { vendorId: 0x1209, productId: 0xb17a },
      trustedUpdateKeys: controllerFixtures.updateAuthorityKeys,
      userActivation: () => true,
      continuityStore: store,
    });
    await expect(recovered.requestPermission()).resolves.toMatchObject({ mode: "recovered" });
  });

  test("cannot become ready when USB disconnects during durable establishment", async () => {
    // Arrange
    const device = makeDevice("fixture-worker-01");
    const harness = webUsbHarness({ devices: [device] });
    let finishEstablishment: (() => void) | undefined;
    const baseStore = memoryContinuityStore();
    const delayedStore: WorkerContinuityStore = {
      ...baseStore,
      async compareAndEstablish(record) {
        await new Promise<void>((resolve) => {
          finishEstablishment = resolve;
        });
        return baseStore.compareAndEstablish(record);
      },
    };
    const controller = testController({
      usb: harness.usb,
      deviceFilter: { vendorId: 0x1209, productId: 0xb17a },
      trustedUpdateKeys: controllerFixtures.updateAuthorityKeys,
      userActivation: () => true,
      continuityStore: delayedStore,
    });

    // Act
    const permission = controller.requestPermission();
    await waitFor(() => finishEstablishment !== undefined);
    harness.disconnect(device);
    finishEstablishment?.();

    // Assert
    await expect(permission).rejects.toThrow("admission continuity was lost");
    await expect(controller.status()).rejects.toThrow("reacquisition is required");
  });

  test("rejects a Work Lease from another challenge before writing it", async () => {
    // Arrange
    const harness = webUsbHarness();
    const controller = testController({
      usb: harness.usb,
      deviceFilter: { vendorId: 0x1209, productId: 0xb17a },
      trustedUpdateKeys: controllerFixtures.updateAuthorityKeys,
      userActivation: () => true,
    });
    await controller.requestPermission();
    const wrongChallenge = {
      ...controllerFixtures.lease,
      challengeId: "challenge_00000000000000000000000000000002",
    } as WorkerLeaseGrantV03;

    // Act
    const start = controller.startLease(wrongChallenge);

    // Assert
    await expect(start).rejects.toThrow("does not match Worker continuity scope");
    expect(harness.commands()).toEqual(["discover", "prove_possession"]);
  });

  test("rejects forged capability before any Work Lease write", async () => {
    // Arrange
    const forged = structuredClone(controllerFixtures.capabilities);
    forged.attestation.compactJws = `${forged.attestation.compactJws.slice(0, -1)}A`;
    const harness = webUsbHarness({ maybeCapability: forged });
    const controller = testController({
      usb: harness.usb,
      deviceFilter: { vendorId: 0x1209, productId: 0xb17a },
      trustedUpdateKeys: controllerFixtures.updateAuthorityKeys,
      userActivation: () => true,
    });

    // Act
    const permission = controller.requestPermission();

    // Assert
    await expect(permission).rejects.toThrow("device admission failed");
    expect(harness.commands()).toEqual(["discover"]);
  });

  test("requires restoration proof from the same physical Worker after disconnect", async () => {
    // Arrange
    const first = makeDevice("fixture-worker-01");
    const replacement = makeDevice("fixture-worker-01", {
      maybeIdentity: crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"]),
    });
    const restored = makeDevice("fixture-worker-01", {
      maybeStatus: {
        protocolVersion: "bwg-worker-controller/0.3",
        state: "baseline",
        monotonicMilliseconds: 10,
        restoration: { status: "confirmed", reason: "connectivity_lost" },
      },
    });
    const harness = webUsbHarness({ devices: [first, replacement, restored] });
    const controller = testController({
      usb: harness.usb,
      deviceFilter: { vendorId: 0x1209, productId: 0xb17a },
      trustedUpdateKeys: controllerFixtures.updateAuthorityKeys,
      userActivation: () => true,
    });
    const disconnects: string[] = [];
    controller.subscribeDisconnect?.(async (reason) => {
      disconnects.push(reason);
    });
    await controller.requestPermission();

    // Act
    harness.disconnect(first);
    const beforeReacquisition = controller.status();
    const wrongWorker = controller.reacquire();

    // Assert
    await expect(beforeReacquisition).rejects.toThrow("reacquisition is required");
    await expect(wrongWorker).rejects.toThrow("device admission failed");
    const restoration = await controller.reacquire();
    expect(restoration).toMatchObject({
      state: "baseline",
      restoration: { status: "confirmed", reason: "connectivity_lost" },
    });
    expect(disconnects).toEqual(["connectivity_lost"]);
  });

  test("rejects reacquisition when restoration confirms the wrong reason", async () => {
    // Arrange
    const first = makeDevice("fixture-worker-01");
    const wronglyRestored = makeDevice("fixture-worker-01", {
      maybeStatus: {
        protocolVersion: "bwg-worker-controller/0.3",
        state: "baseline",
        monotonicMilliseconds: 10,
        restoration: { status: "confirmed", reason: "paused" },
      },
    });
    const harness = webUsbHarness({ devices: [first, wronglyRestored] });
    const controller = testController({
      usb: harness.usb,
      deviceFilter: { vendorId: 0x1209, productId: 0xb17a },
      trustedUpdateKeys: controllerFixtures.updateAuthorityKeys,
      userActivation: () => true,
    });
    await controller.requestPermission();
    harness.disconnect(first);

    // Act
    const reacquisition = controller.reacquire();

    // Assert
    await expect(reacquisition).rejects.toThrow("restoration is unconfirmed");
    await expect(controller.status()).rejects.toThrow("reacquisition is required");
  });

  test("rejects stale reuse of the previous USB enumeration", async () => {
    // Arrange
    const first = makeDevice("fixture-worker-01");
    const harness = webUsbHarness({ devices: [first, first] });
    const controller = testController({
      usb: harness.usb,
      deviceFilter: { vendorId: 0x1209, productId: 0xb17a },
      trustedUpdateKeys: controllerFixtures.updateAuthorityKeys,
      userActivation: () => true,
    });
    await controller.requestPermission();
    harness.disconnect(first);

    // Act
    const reacquisition = controller.reacquire();

    // Assert
    await expect(reacquisition).rejects.toThrow("enumeration continuity is invalid");
    await expect(controller.status()).rejects.toThrow("reacquisition is required");
    expect(deviceCommands(first)).toEqual(["discover", "prove_possession"]);
  });

  test("keeps control unavailable until disconnect handling completes", async () => {
    // Arrange
    const first = makeDevice("fixture-worker-01");
    const restored = restoredDevice("fixture-worker-01");
    const harness = webUsbHarness({ devices: [first, restored] });
    const controller = testController({
      usb: harness.usb,
      deviceFilter: { vendorId: 0x1209, productId: 0xb17a },
      trustedUpdateKeys: controllerFixtures.updateAuthorityKeys,
      userActivation: () => true,
    });
    let releaseListener: (() => void) | undefined;
    controller.subscribeDisconnect?.(
      () => new Promise<void>((resolve) => {
        releaseListener = resolve;
      }),
    );
    await controller.requestPermission();
    harness.disconnect(first);

    // Act
    const reacquisition = controller.reacquire();
    await waitFor(() => releaseListener !== undefined);
    const whileHandlingDisconnect = controller.status();
    releaseListener?.();

    // Assert
    await expect(whileHandlingDisconnect).rejects.toThrow("permission is required");
    await expect(reacquisition).resolves.toMatchObject({ state: "baseline" });
  });

  test("cannot become ready after a second disconnect during host disconnect handling", async () => {
    // Arrange
    const first = makeDevice("fixture-worker-01");
    const restored = restoredDevice("fixture-worker-01");
    const harness = webUsbHarness({ devices: [first, restored] });
    const controller = testController({
      usb: harness.usb,
      deviceFilter: { vendorId: 0x1209, productId: 0xb17a },
      trustedUpdateKeys: controllerFixtures.updateAuthorityKeys,
      userActivation: () => true,
    });
    let releaseListener: (() => void) | undefined;
    controller.subscribeDisconnect?.(
      () => new Promise<void>((resolve) => {
        releaseListener = resolve;
      }),
    );
    await controller.requestPermission();
    harness.disconnect(first);
    const reacquisition = controller.reacquire();
    await waitFor(() => releaseListener !== undefined);

    // Act
    harness.disconnect(restored);
    releaseListener?.();

    // Assert
    await expect(reacquisition).rejects.toThrow("admission continuity was lost");
    await expect(controller.status()).rejects.toThrow("reacquisition is required");
  });

  test("fails closed when disconnect handling rejects", async () => {
    // Arrange
    const first = makeDevice("fixture-worker-01");
    const restored = restoredDevice("fixture-worker-01");
    const harness = webUsbHarness({ devices: [first, restored] });
    const controller = testController({
      usb: harness.usb,
      deviceFilter: { vendorId: 0x1209, productId: 0xb17a },
      trustedUpdateKeys: controllerFixtures.updateAuthorityKeys,
      userActivation: () => true,
    });
    controller.subscribeDisconnect?.(async () => {
      throw new Error("secret Authority pause failure");
    });
    await controller.requestPermission();
    harness.disconnect(first);

    // Act
    const reacquisition = controller.reacquire();

    // Assert
    await expect(reacquisition).rejects.toThrow("disconnect handling failed");
    await expect(controller.status()).rejects.toThrow("reacquisition is required");
  });

  test("restores Mining Baseline before releasing and closing the device", async () => {
    // Arrange
    const events: string[] = [];
    const device = makeDevice("fixture-worker-01", { events });
    const harness = webUsbHarness({ devices: [device] });
    const controller = testController({
      usb: harness.usb,
      deviceFilter: { vendorId: 0x1209, productId: 0xb17a },
      trustedUpdateKeys: controllerFixtures.updateAuthorityKeys,
      userActivation: () => true,
    });
    await controller.requestPermission();

    // Act
    await controller.close("tab_closed");

    // Assert
    expect(events.slice(-4)).toEqual([
      "write:restore",
      "read:restore",
      "release:0",
      "close",
    ]);
  });

  test("fails closed after response loss without exposing device or lease secrets", async () => {
    // Arrange
    const device = makeDevice("secret-serial-must-not-escape", {
      maybeResponseLossCommand: "start_lease",
    });
    const harness = webUsbHarness({ devices: [device] });
    const controller = testController({
      usb: harness.usb,
      deviceFilter: { vendorId: 0x1209, productId: 0xb17a },
      trustedUpdateKeys: controllerFixtures.updateAuthorityKeys,
      userActivation: () => true,
      transferTimeoutMilliseconds: 1,
    });
    await controller.requestPermission();

    // Act
    const start = controller.startLease(controllerFixtures.lease as WorkerLeaseGrantV03);

    // Assert
    await expect(start).rejects.toThrow("response was lost; reacquisition is required");
    await expect(controller.status()).rejects.toThrow("reacquisition is required");
    const messages = await start.catch((error: unknown) =>
      error instanceof Error ? error.message : String(error),
    );
    expect(messages).not.toMatch(/secret-serial|fixture-authentication|password/i);
    expect(harness.commands()).toEqual(["discover", "prove_possession", "start_lease"]);
  });

  test("treats an invalid successful status as an outcome-unknown response", async () => {
    // Arrange
    const device = makeDevice("fixture-worker-01", {
      maybeInvalidStatusCommand: "start_lease",
    });
    const harness = webUsbHarness({ devices: [device] });
    const controller = testController({
      usb: harness.usb,
      deviceFilter: { vendorId: 0x1209, productId: 0xb17a },
      trustedUpdateKeys: controllerFixtures.updateAuthorityKeys,
      userActivation: () => true,
    });
    await controller.requestPermission();

    // Act
    const start = controller.startLease(controllerFixtures.lease as WorkerLeaseGrantV03);

    // Assert
    await expect(start).rejects.toThrow("response was lost; reacquisition is required");
    await expect(controller.status()).rejects.toThrow("reacquisition is required");
  });

  test("rejects an invalid restoration reason before writing", async () => {
    // Arrange
    const harness = webUsbHarness();
    const controller = testController({
      usb: harness.usb,
      deviceFilter: { vendorId: 0x1209, productId: 0xb17a },
      trustedUpdateKeys: controllerFixtures.updateAuthorityKeys,
      userActivation: () => true,
    });
    await controller.requestPermission();

    // Act
    const restoration = controller.restore("password=must-not-write" as "paused");

    // Assert
    await expect(restoration).rejects.toThrow("restoration reason is invalid");
    expect(harness.commands()).toEqual(["discover", "prove_possession"]);
  });

  test("reports explicit cleanup failure instead of clearing the device silently", async () => {
    // Arrange
    const device = makeDevice("fixture-worker-01", { releaseFails: true });
    const harness = webUsbHarness({ devices: [device] });
    const controller = testController({
      usb: harness.usb,
      deviceFilter: { vendorId: 0x1209, productId: 0xb17a },
      trustedUpdateKeys: controllerFixtures.updateAuthorityKeys,
      userActivation: () => true,
    });
    await controller.requestPermission();

    // Act
    const cleanup = controller.close("tab_closed");

    // Assert
    await expect(cleanup).rejects.toThrow("interface release failed");
    await expect(controller.status()).rejects.toThrow("permission is required");
  });

  test("keeps the adapter usable after a normalized device command rejection", async () => {
    // Arrange
    const device = makeDevice("fixture-worker-01", {
      maybeRejectedCommand: "start_lease",
    });
    const harness = webUsbHarness({ devices: [device] });
    const controller = testController({
      usb: harness.usb,
      deviceFilter: { vendorId: 0x1209, productId: 0xb17a },
      trustedUpdateKeys: controllerFixtures.updateAuthorityKeys,
      userActivation: () => true,
    });
    await controller.requestPermission();

    // Act
    const start = controller.startLease(controllerFixtures.lease as WorkerLeaseGrantV03);

    // Assert
    await expect(start).rejects.toThrow("Worker Controller command was rejected");
    expect((await controller.status()).state).toBe("baseline");
  });

});
