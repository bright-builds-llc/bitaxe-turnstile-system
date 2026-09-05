import { expect, test } from "bun:test";

import fixtures from "../conformance/bwg-worker-controller-0.4/fixtures.json";
import {
  SimulatedWorkerController,
  SimulatedWorkerControllerClock,
} from "./simulated-worker-controller";
import { simulatedWorkerControllerSerialExchange } from "./simulated-worker-controller-serial";
import type {
  WorkerControllerCapabilities,
  WorkerControllerStatus,
  WorkerLeaseGrant,
  WorkerLeaseRenewal,
} from "./worker-controller";
import {
  fixtureAuthorizationVerifier,
  fixtureInput,
} from "./worker-controller.test-support";
import {
  decodeWorkerControllerSerialResponse,
  encodeWorkerControllerSerialMessage,
  type WorkerControllerSerialResponse,
} from "./worker-controller-serial";

type Step = {
  operation:
    | "discover"
    | "start"
    | "renew"
    | "status"
    | "pause"
    | "cancel"
    | "advance_monotonic"
    | "reset_monotonic"
    | "lose_continuity"
    | "reboot";
  input?: string;
  value?: string | number;
};
type Scenario = {
  id: string;
  steps: readonly Step[];
  expected: {
    capabilities?: boolean;
    state?: "baseline" | "mining";
    reason?: WorkerControllerStatus["restoration"]["reason"];
    error?: string;
    redacted?: boolean;
  };
};
const scenarios = fixtures.scenarios as readonly Scenario[];

const ids = scenarios.map((scenario) => scenario.id);
if (new Set(ids).size !== ids.length) throw new Error("conformance scenario IDs are duplicated");

for (const scenario of scenarios) {
  test(`shared Worker Controller fixture: ${scenario.id}`, async () => {
    // Arrange
    const clock = new SimulatedWorkerControllerClock("boot_conformance_01", 0, 1);
    const controller = new SimulatedWorkerController(
      fixtures.capabilities as WorkerControllerCapabilities,
      clock,
      fixtureAuthorizationVerifier,
    );

    // Act
    let maybeStatus: WorkerControllerStatus | undefined;
    let maybeCapabilities: WorkerControllerCapabilities | undefined;
    let maybeError: unknown;
    try {
      for (const step of scenario.steps) {
        const result = await executeStep(controller, clock, step);
        if (result?.kind === "status") maybeStatus = result.value;
        if (result?.kind === "capabilities") maybeCapabilities = result.value;
      }
      maybeStatus = await controller.status();
    } catch (error) {
      maybeError = error;
    }

    // Assert
    if (scenario.expected.error) {
      expect(maybeError).toBeInstanceOf(Error);
      expect((maybeError as Error).message).toContain(scenario.expected.error);
      return;
    }
    expect(maybeError).toBeUndefined();
    if (scenario.expected.capabilities) {
      expect(maybeCapabilities).toEqual(
        fixtures.capabilities as WorkerControllerCapabilities,
      );
    }
    if (scenario.expected.state) expect(maybeStatus?.state).toBe(scenario.expected.state);
    if (scenario.expected.reason) {
      expect(maybeStatus?.restoration.reason).toBe(scenario.expected.reason);
    }
    if (scenario.expected.redacted) assertRedacted(maybeStatus);
  });
}

for (const vector of fixtures.usbVectors) {
  test(`shared Worker Controller Serial vector: ${vector.id}`, async () => {
    // Arrange
    const controller = new SimulatedWorkerController(
      fixtures.capabilities as WorkerControllerCapabilities,
      new SimulatedWorkerControllerClock("boot_serial_vector_01", 0, 1),
      fixtureAuthorizationVerifier,
    );
    const exchange = simulatedWorkerControllerSerialExchange(controller);

    // Act
    const response = decodeWorkerControllerSerialResponse(
      await exchange.transact(encodeWorkerControllerSerialMessage(vector.request)),
    );

    // Assert
    expect(response).toEqual(vector.response as WorkerControllerSerialResponse);
  });
}

async function executeStep(
  controller: SimulatedWorkerController,
  clock: SimulatedWorkerControllerClock,
  step: Step,
) {
  switch (step.operation) {
    case "discover":
      return { kind: "capabilities" as const, value: await controller.discover() };
    case "start":
      return { kind: "status" as const, value: await controller.startLease(startInput(step)) };
    case "renew":
      return { kind: "status" as const, value: await controller.renewLease(renewalInput(step)) };
    case "status":
      return { kind: "status" as const, value: await controller.status() };
    case "pause":
      return { kind: "status" as const, value: await controller.pause() };
    case "cancel":
      return { kind: "status" as const, value: await controller.cancel() };
    case "advance_monotonic":
      clock.advanceMonotonic(numberValue(step));
      return undefined;
    case "reset_monotonic":
      clock.resetMonotonic(numberValue(step));
      return undefined;
    case "lose_continuity":
      clock.loseContinuity(stringValue(step));
      return undefined;
    case "reboot":
      clock.reboot(stringValue(step));
      return undefined;
  }
}

function startInput(step: Step): WorkerLeaseGrant {
  if (!step.input || !(step.input in fixtures.inputs)) {
    throw new Error("unknown start fixture input");
  }
  return fixtureInput(step.input as keyof typeof fixtures.inputs) as WorkerLeaseGrant;
}

function renewalInput(step: Step): WorkerLeaseRenewal {
  if (!step.input || !(step.input in fixtures.inputs)) {
    throw new Error("unknown renewal fixture input");
  }
  return fixtureInput(step.input as keyof typeof fixtures.inputs) as WorkerLeaseRenewal;
}

function numberValue(step: Step): number {
  if (typeof step.value !== "number") throw new Error("scenario number is missing");
  return step.value;
}

function stringValue(step: Step): string {
  if (typeof step.value !== "string") throw new Error("scenario string is missing");
  return step.value;
}

function assertRedacted(maybeStatus: WorkerControllerStatus | undefined): void {
  const status = JSON.stringify(maybeStatus);
  expect(status).not.toContain(fixtures.lease.authorization);
  expect(status).not.toContain(fixtures.lease.stratum.username);
  expect(status).not.toContain(fixtures.lease.stratum.password);
}
