import { expect, test } from "bun:test";

import fixtures from "../conformance/bwg-worker-usb-0.1/fixtures.json";
import {
  applyWorkerUsbSessionEvent,
  initialWorkerUsbSession,
  parseWorkerEnumerationIdentity,
  parseWorkerPhysicalIdentity,
  parseWorkerUsbTransportProfile,
  type WorkerUsbSessionState,
} from "./worker-usb-profile";

type Scenario = {
  id: string;
  events: readonly string[];
  expectedState?: WorkerUsbSessionState["state"];
  expectedError?: string;
};

for (const scenario of fixtures.scenarios as readonly Scenario[]) {
  test(`shared Worker USB fixture: ${scenario.id}`, () => {
    // Arrange
    let state = initialWorkerUsbSession();
    let maybeError: unknown;

    // Act
    try {
      for (const event of scenario.events) state = applyFixtureEvent(state, event);
    } catch (error) {
      maybeError = error;
    }

    // Assert
    if (scenario.expectedError) {
      expect(maybeError).toBeInstanceOf(Error);
      expect((maybeError as Error).message).toContain("application reacquisition failed");
      return;
    }
    expect(maybeError).toBeUndefined();
    if (!scenario.expectedState) throw new Error("Worker USB fixture expected state is missing");
    expect(state.state).toBe(scenario.expectedState);
  });
}

function applyFixtureEvent(state: WorkerUsbSessionState, event: string): WorkerUsbSessionState {
  const workerA = parseWorkerPhysicalIdentity(fixtures.identities.workerA);
  const workerB = parseWorkerPhysicalIdentity(fixtures.identities.workerB);
  const bootloader = parseWorkerEnumerationIdentity(fixtures.identities.bootloaderEnumeration);
  const application = parseWorkerEnumerationIdentity(fixtures.identities.applicationEnumeration);
  const restored = parseWorkerEnumerationIdentity(fixtures.identities.restoredEnumeration);
  switch (event) {
    case "bootloader_admitted":
      return applyWorkerUsbSessionEvent(state, {
        type: event,
        physicalIdentity: workerA,
        enumerationIdentity: bootloader,
      });
    case "application_observed":
      return applyWorkerUsbSessionEvent(state, {
        type: event,
        physicalIdentity: workerA,
        enumerationIdentity: application,
        profile: parseWorkerUsbTransportProfile(fixtures.topology),
      });
    case "same_enumeration_observed":
      return applyWorkerUsbSessionEvent(state, {
        type: "application_observed",
        physicalIdentity: workerA,
        enumerationIdentity: bootloader,
        profile: parseWorkerUsbTransportProfile(fixtures.topology),
      });
    case "application_admitted":
    case "lease_started":
      return applyWorkerUsbSessionEvent(state, { type: event });
    case "evidence_observed":
      return applyWorkerUsbSessionEvent(state, {
        type: event,
        category: "json_shaped_log",
      });
    case "control_lost":
    case "response_lost":
      return applyWorkerUsbSessionEvent(state, { type: event });
    case "identity_drift":
      return applyWorkerUsbSessionEvent(state, {
        type: event,
        observedPhysicalIdentity: workerB,
      });
    case "restoration_confirmed":
      return applyWorkerUsbSessionEvent(state, {
        type: event,
        physicalIdentity: workerA,
        enumerationIdentity: restored,
      });
    default:
      throw new Error(`unknown Worker USB fixture event: ${event}`);
  }
}
