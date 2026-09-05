import fixtures from "../conformance/bwg-worker-controller-0.4/fixtures.json";
import headlessFixtures from "../conformance/bwg-0.1/headless-work-consent-vectors.json";
import type {
  WorkerController,
  WorkerControllerCapabilities,
  WorkerControllerStatus,
} from "./worker-controller";

export function recordingWorkerController(calls: string[]): WorkerController {
  const capabilities = fixtures.capabilities as WorkerControllerCapabilities;
  const baseline = (
    reason: WorkerControllerStatus["restoration"]["reason"],
  ): WorkerControllerStatus => ({
    protocolVersion: "bwg-worker-controller/0.4",
    state: "baseline",
    monotonicMilliseconds: 0,
    restoration: { status: "confirmed", ...(reason ? { reason } : {}) },
  });
  const mining: WorkerControllerStatus = {
    protocolVersion: "bwg-worker-controller/0.4",
    state: "mining",
    monotonicMilliseconds: 0,
    lease: {
      leaseId: fixtures.lease.leaseId,
      challengeId: headlessFixtures.challenge.challengeId,
      renewAtMonotonicMilliseconds: 20_000,
      expiresAtMonotonicMilliseconds: 60_000,
    },
    restoration: { status: "pending" },
  };
  return {
    async discover() {
      calls.push("discover");
      return capabilities;
    },
    async startLease() {
      calls.push("start");
      return mining;
    },
    async renewLease() {
      calls.push("renew");
      return mining;
    },
    async status() {
      calls.push("status");
      return baseline("paused");
    },
    async pause() {
      calls.push("pause");
      return baseline("paused");
    },
    async cancel() {
      calls.push("cancel");
      return baseline("cancelled");
    },
    async restore(reason) {
      calls.push(`restore:${reason}`);
      return baseline(reason);
    },
  };
}
