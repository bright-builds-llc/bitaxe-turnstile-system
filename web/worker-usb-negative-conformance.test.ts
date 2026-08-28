import { expect, test } from "bun:test";

import fixtures from "../conformance/bwg-worker-usb-0.1/fixtures.json";
import {
  decodeWorkerControllerUsbRequestV02,
  encodeWorkerControllerUsbMessageV02,
} from "./worker-controller-usb-v02";
import {
  applyWorkerUsbSessionEvent,
  initialWorkerUsbSession,
  parseWorkerEnumerationIdentity,
  parseWorkerPhysicalIdentity,
  parseWorkerUsbTransportProfile,
} from "./worker-usb-profile";

for (const vector of fixtures.negativeVectors) {
  test(`shared Worker USB negative fixture: ${vector.id}`, () => {
    // Arrange
    const operation = () => executeNegativeVector(vector.operation);

    // Act / Assert
    expect(operation).toThrow(expectedMessage(vector.expectedError));
  });
}

function executeNegativeVector(operation: string): void {
  if (operation === "start_lease_from_bootloader") {
    const state = applyWorkerUsbSessionEvent(initialWorkerUsbSession(), {
      type: "bootloader_admitted",
      physicalIdentity: parseWorkerPhysicalIdentity(fixtures.identities.workerA),
      enumerationIdentity: parseWorkerEnumerationIdentity(
        fixtures.identities.bootloaderEnumeration,
      ),
    });
    applyWorkerUsbSessionEvent(state, { type: "lease_started" });
    return;
  }
  if (
    operation === "send_multiple_control_frames" ||
    operation === "prefix_control_with_runtime_log"
  ) {
    const request = encodeWorkerControllerUsbMessageV02({
      protocolVersion: "bwg-worker-controller/0.2",
      requestId: "usb_negative_fixture",
      command: "discover",
    });
    const prefix =
      operation === "send_multiple_control_frames"
        ? request
        : new TextEncoder().encode("runtime_log=not_a_controller_frame\n");
    const combined = new Uint8Array(prefix.byteLength + request.byteLength);
    combined.set(prefix);
    combined.set(request, prefix.byteLength);
    decodeWorkerControllerUsbRequestV02(combined);
    return;
  }
  const topology = structuredClone(fixtures.topology) as unknown;
  const root = record(topology);
  if (operation === "add_unknown_profile_field") {
    root.password = "must-not-enter-profile";
  } else if (operation === "change_control_interface_number") {
    const application = record(root.application);
    const descriptor = record(application.descriptor);
    const control = record(descriptor.control);
    control.interfaceNumber = 4;
  } else {
    const application = record(root.application);
    const functions = array(application.functions);
    const evidence = record(functions[1]);
    if (operation === "evidence_claims_control_role") {
      evidence.role = "worker_control";
    } else if (operation === "duplicate_control_function") {
      functions[1] = structuredClone(functions[0]);
    } else {
      throw new Error(`unknown negative fixture operation: ${operation}`);
    }
  }
  parseWorkerUsbTransportProfile(topology);
}

function expectedMessage(category: string): string {
  if (category === "invalid_profile") return "Worker USB transport profile is invalid";
  if (category === "invalid_descriptor") return "Worker USB application descriptor is invalid";
  if (category === "invalid_transition") return "Worker USB session transition is invalid";
  if (category === "invalid_frame") return "Worker Controller 0.2 USB frame is invalid";
  throw new Error(`unknown negative fixture category: ${category}`);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("negative fixture record is invalid");
  }
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("negative fixture array is invalid");
  return value;
}
