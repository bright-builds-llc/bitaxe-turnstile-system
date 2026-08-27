import { describe, expect, test } from "bun:test";

import fixtures from "../conformance/bwg-worker-controller-0.1/fixtures.json";
import {
  SimulatedWorkerController,
  SimulatedWorkerControllerClock,
} from "./simulated-worker-controller";
import type {
  WorkerControllerCapabilities,
  WorkerLeaseGrant,
  WorkerLeaseRenewal,
} from "./worker-controller";
import {
  parseWorkerControllerStatus,
  parseWorkerLeaseGrant,
} from "./worker-controller";
import { fixtureAuthorizationVerifier } from "./worker-controller.test-support";

const fixtureCapabilities = fixtures.capabilities as WorkerControllerCapabilities;
const lease = fixtures.lease as WorkerLeaseGrant;
const renewal = fixtures.renewal as WorkerLeaseRenewal;

describe("Worker Controller capability contract", () => {
  test("discovers only versioned non-secret compatibility metadata", async () => {
    // Arrange
    const controller = simulator();

    // Act
    const capabilities = await controller.discover();

    // Assert
    expect(capabilities).toEqual(fixtureCapabilities);
    expect(JSON.stringify(capabilities)).not.toMatch(
      /password|credential|private|wifi|ssid|pool[_-]?setting|device[_-]?identity/i,
    );
  });
});

describe("Worker Controller status invariants", () => {
  test.each([
    {
      state: "mining",
      lease: {
        leaseId: "lease_invalid_01",
        challengeId: "challenge_invalid_01",
        renewAtMonotonicMilliseconds: 20_000,
        expiresAtMonotonicMilliseconds: 60_000,
      },
      restoration: { status: "confirmed", reason: "paused" },
    },
    {
      state: "baseline",
      restoration: { status: "pending" },
    },
  ])("rejects contradictory $state status", (contradiction) => {
    // Act
    const parse = () =>
      parseWorkerControllerStatus({
        protocolVersion: "bwg-worker-controller/0.1",
        monotonicMilliseconds: 0,
        ...contradiction,
      });

    // Assert
    expect(parse).toThrow("Worker Controller status is invalid");
  });
});

describe("Worker Controller monotonic lease contract", () => {
  test("starts and renews against monotonic deadlines without wall time", async () => {
    // Arrange
    const clock = new SimulatedWorkerControllerClock("boot_fixture_01", 1000, 1_700_000_000);
    const controller = simulator(clock);
    await controller.startLease(lease);
    clock.jumpWallTime(4_000_000_000);
    clock.advanceMonotonic(19_999);

    // Act
    const beforeRenewal = await controller.status();
    const renewed = await controller.renewLease(renewal);

    // Assert
    expect(beforeRenewal.state).toBe("mining");
    expect(beforeRenewal.lease?.renewAtMonotonicMilliseconds).toBe(21_000);
    expect(beforeRenewal.lease?.expiresAtMonotonicMilliseconds).toBe(61_000);
    expect(renewed.lease?.renewAtMonotonicMilliseconds).toBe(40_999);
    expect(renewed.lease?.expiresAtMonotonicMilliseconds).toBe(80_999);
  });

  test("status remains valid after the renewal hint and before expiry", async () => {
    // Arrange
    const clock = new SimulatedWorkerControllerClock("boot_fixture_hint", 0, 1);
    const controller = simulator(clock);
    await controller.startLease(lease);
    clock.advanceMonotonic(20_000);

    // Act
    const status = await controller.status();

    // Assert
    expect(status.state).toBe("mining");
    expect(status.lease?.renewAtMonotonicMilliseconds).toBe(20_000);
    expect(status.lease?.expiresAtMonotonicMilliseconds).toBe(60_000);
  });

  test("expiry restores the Mining Baseline without a controller round trip", async () => {
    // Arrange
    const clock = new SimulatedWorkerControllerClock("boot_fixture_02", 0, 1);
    const restorations: string[] = [];
    const controller = simulator(clock, (reason) => restorations.push(reason));
    await controller.startLease(lease);

    // Act
    clock.advanceMonotonic(60_000);

    // Assert
    expect(restorations).toEqual(["lease_expired"]);
    const status = await controller.status();
    expect(status).toMatchObject({
      state: "baseline",
      restoration: { status: "confirmed", reason: "lease_expired" },
    });
    expect(status.lease).toBeUndefined();
  });

  test("lost continuity restores instead of resuming", async () => {
    // Arrange
    const lostClock = new SimulatedWorkerControllerClock("boot_fixture_03", 0, 1);
    const restorations: string[] = [];
    const lost = simulator(lostClock, (reason) => restorations.push(reason));
    await lost.startLease(lease);

    // Act
    lostClock.loseContinuity("boot_fixture_03_lost");

    // Assert
    expect(restorations).toEqual(["lost_continuity"]);
    const lostStatus = await lost.status();
    expect(lostStatus.restoration).toEqual({
      status: "confirmed",
      reason: "lost_continuity",
    });
  });

  test("reboot restores instead of resuming", async () => {
    // Arrange
    const rebootClock = new SimulatedWorkerControllerClock("boot_fixture_04", 1000, 1);
    const restorations: string[] = [];
    const rebooted = simulator(rebootClock, (reason) => restorations.push(reason));
    await rebooted.startLease(lease);

    // Act
    rebootClock.reboot("boot_fixture_04_rebooted");

    // Assert
    expect(restorations).toEqual(["reboot"]);
    const rebootStatus = await rebooted.status();
    expect(rebootStatus.restoration).toEqual({ status: "confirmed", reason: "reboot" });
  });

  test("a monotonic reset restores instead of extending the lease", async () => {
    // Arrange
    const clock = new SimulatedWorkerControllerClock("boot_fixture_reset", 10_000, 1);
    const controller = simulator(clock);
    await controller.startLease(lease);
    clock.advanceMonotonic(1_000);
    await controller.status();
    clock.resetMonotonic(12_000);

    // Act
    const status = await controller.status();

    // Assert
    expect(status.restoration).toEqual({
      status: "confirmed",
      reason: "monotonic_reset",
    });
  });

  test("a rebooted controller accepts only a fresh lease", async () => {
    // Arrange
    const clock = new SimulatedWorkerControllerClock("boot_fixture_fresh", 1_000, 1);
    const controller = simulator(clock);
    await controller.startLease(lease);
    clock.reboot("boot_fixture_fresh_rebooted");
    await controller.status();

    // Act
    const restarted = await controller.startLease({ ...lease, leaseId: "lease_fixture_02" });

    // Assert
    expect(restarted.state).toBe("mining");
    expect(restarted.lease?.leaseId).toBe("lease_fixture_02");
  });

  test.each([Number.MAX_SAFE_INTEGER + 1, -1])(
    "rejects unsafe initial monotonic time %s",
    (monotonicMilliseconds) => {
      // Act
      const create = () =>
        new SimulatedWorkerControllerClock("boot_invalid_clock", monotonicMilliseconds, 1);

      // Assert
      expect(create).toThrow("monotonic time is invalid");
    },
  );
});

describe("Worker Controller restoration and negative contract", () => {
  test.each([
    ["pause", "paused"],
    ["cancel", "cancelled"],
  ] as const)("%s restores and confirms the Mining Baseline", async (command, reason) => {
    // Arrange
    const controller = simulator();
    await controller.startLease(lease);

    // Act
    const status = await controller[command]();

    // Assert
    expect(status).toMatchObject({
      state: "baseline",
      restoration: { status: "confirmed", reason },
    });
  });

  test("rejects an oversized lease without changing the baseline", async () => {
    // Arrange
    const controller = simulator();

    // Act
    const start = controller.startLease({ ...lease, durationMilliseconds: 60_001 });

    // Assert
    await expect(start).rejects.toThrow("lease duration is outside the contract");
    expect((await controller.status()).state).toBe("baseline");
  });

  test.each([
    "stratum+tcp://user@127.0.0.1:3333/",
    "stratum+tcp://127.0.0.1:0/",
    "stratum+tcp://127.0.0.1:65536/",
  ])("rejects unsafe Stratum endpoint %s", (endpoint) => {
    // Act
    const parse = () => parseWorkerLeaseGrant({ ...lease, stratum: { ...lease.stratum, endpoint } });

    // Assert
    expect(parse).toThrow("Work Lease grant is invalid");
  });

  test("rejects an unauthenticated lease without capturing the baseline", async () => {
    // Arrange
    const controller = simulator();

    // Act
    const start = controller.startLease({ ...lease, authorization: "invalid" });

    // Assert
    await expect(start).rejects.toThrow("Work Lease authentication failed");
    expect((await controller.status()).restoration.status).toBe("not_required");
  });

  test("rejects altered work configuration under a valid authorization", async () => {
    // Arrange
    const controller = simulator();

    // Act
    const start = controller.startLease({
      ...lease,
      challengeId: "challenge_00000000000000000000000000000002",
    });

    // Assert
    await expect(start).rejects.toThrow("Work Lease authentication failed");
    expect((await controller.status()).state).toBe("baseline");
  });

  test("rejects a renewal after the monotonic deadline", async () => {
    // Arrange
    const clock = new SimulatedWorkerControllerClock("boot_fixture_05", 0, 1);
    const controller = simulator(clock);
    await controller.startLease(lease);
    clock.advanceMonotonic(60_000);

    // Act
    const renew = controller.renewLease(renewal);

    // Assert
    await expect(renew).rejects.toThrow("Work Lease is not active");
    expect((await controller.status()).restoration.reason).toBe("lease_expired");
  });

  test("rejects a renewal for a different lease", async () => {
    // Arrange
    const controller = simulator();
    await controller.startLease(lease);

    // Act
    const renew = controller.renewLease({ ...renewal, leaseId: "lease_other_01" });

    // Assert
    await expect(renew).rejects.toThrow("Work Lease authentication failed");
    expect((await controller.status()).lease?.leaseId).toBe(lease.leaseId);
  });

  test("rejects secret-bearing capability extensions", () => {
    // Arrange
    const unsafe = { ...fixtureCapabilities, wifiPassword: "do-not-expose" };

    // Act
    const create = () =>
      new SimulatedWorkerController(
        unsafe as WorkerControllerCapabilities,
        new SimulatedWorkerControllerClock("boot_unsafe", 0, 1),
        fixtureAuthorizationVerifier,
      );

    // Assert
    expect(create).toThrow("public shape contains an unknown field");
  });

  test("public status and diagnostics omit lease secrets and baseline settings", async () => {
    // Arrange
    const controller = simulator();
    await controller.startLease(lease);

    // Act
    const diagnostic = JSON.stringify(await controller.status());

    // Assert
    expect(diagnostic).not.toContain(lease.authorization);
    expect(diagnostic).not.toContain(lease.stratum.username);
    expect(diagnostic).not.toContain(lease.stratum.password);
    expect(diagnostic).not.toMatch(/wifi|ssid|private|payout|pool[_-]?setting/i);
  });
});

function simulator(
  clock = new SimulatedWorkerControllerClock("boot_fixture_default", 0, 1),
  onRestoration: (reason: string) => void = () => undefined,
): SimulatedWorkerController {
  return new SimulatedWorkerController(
    fixtureCapabilities,
    clock,
    fixtureAuthorizationVerifier,
    onRestoration,
  );
}
