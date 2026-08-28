import { describe, expect, test } from "bun:test";

import {
  WORKER_USB_PROFILE_VERSION,
  applyWorkerUsbSessionEvent,
  initialWorkerUsbSession,
  parseWorkerEnumerationIdentity,
  parseWorkerPhysicalIdentity,
  parseWorkerUsbTransportProfile,
} from "./worker-usb-profile";

describe("Worker USB transport profile", () => {
  test("admits only separated bootloader, control, and evidence roles", () => {
    // Arrange
    const profile = exactProfile();

    // Act
    const parsed = parseWorkerUsbTransportProfile(profile);

    // Assert
    expect(parsed.profile).toBe(WORKER_USB_PROFILE_VERSION);
    expect(parsed.application.functions).toEqual([
      {
        role: "worker_control",
        usbClass: "vendor_specific",
        browserTransport: "web_usb",
        direction: "bidirectional",
        content: "controller_frames_only",
      },
      {
        role: "worker_evidence",
        usbClass: "cdc_acm",
        browserTransport: "none",
        direction: "device_to_host",
        content: "redacted_observations_only",
      },
    ]);
    expect(parsed.bootloader.acceptsWorkerController).toBe(false);
    expect(parsed.application.descriptor).toEqual({
      configurationValue: 1,
      control: {
        interfaceNumber: 0,
        alternateSetting: 0,
        classCode: 255,
        subclassCode: 66,
        protocolCode: 1,
        endpointOut: 1,
        endpointIn: 1,
        transferType: "bulk",
      },
      evidence: {
        communicationInterfaceNumber: 1,
        dataInterfaceNumber: 2,
        notificationEndpointIn: 2,
        dataEndpointOut: 3,
        dataEndpointIn: 3,
        hostWritesAccepted: false,
      },
    });
  });

  test("rejects control/evidence crossover and secret-bearing extensions", () => {
    // Arrange
    const crossover = exactProfile();
    const extended = exactProfile();
    const maybeEvidence = crossover.application.functions[1];
    const maybeControl = extended.application.functions[0];
    if (!maybeEvidence || !maybeControl) throw new Error("exact profile fixture is incomplete");
    maybeEvidence.browserTransport = "web_usb";
    Object.assign(maybeControl, { password: "must-not-enter-profile" });

    // Act
    const parseCrossover = () => parseWorkerUsbTransportProfile(crossover);
    const parseExtended = () => parseWorkerUsbTransportProfile(extended);

    // Assert
    expect(parseCrossover).toThrow("Worker USB transport profile is invalid");
    expect(parseExtended).toThrow("Worker USB transport profile is invalid");
  });

  test("rejects object coercion at redacted identity boundaries", () => {
    // Arrange
    const coercible = { toString: () => "A".repeat(43) };

    // Act
    const parsePhysical = () => parseWorkerPhysicalIdentity(coercible);
    const parseEnumeration = () => parseWorkerEnumerationIdentity(coercible);

    // Assert
    expect(parsePhysical).toThrow("Worker physical identity is invalid");
    expect(parseEnumeration).toThrow("Worker enumeration identity is invalid");
  });

  test("requires application reacquisition after the bootloader enumeration", () => {
    // Arrange
    const physicalIdentity = parseWorkerPhysicalIdentity("A".repeat(43));
    const bootloaderEnumeration = parseWorkerEnumerationIdentity("B".repeat(43));
    const applicationEnumeration = parseWorkerEnumerationIdentity("C".repeat(43));
    let state = initialWorkerUsbSession();

    // Act
    state = applyWorkerUsbSessionEvent(state, {
      type: "bootloader_admitted",
      physicalIdentity,
      enumerationIdentity: bootloaderEnumeration,
    });
    state = applyWorkerUsbSessionEvent(state, {
      type: "application_observed",
      physicalIdentity,
      enumerationIdentity: applicationEnumeration,
      profile: parseWorkerUsbTransportProfile(exactProfile()),
    });
    const beforeAdmission = state;
    state = applyWorkerUsbSessionEvent(state, { type: "application_admitted" });

    // Assert
    expect(beforeAdmission).toMatchObject({ state: "application_reacquisition_required" });
    expect(state).toEqual({
      state: "application_ready",
      physicalIdentity,
      enumerationIdentity: applicationEnumeration,
      lease: "none",
    });
  });

  test("identity drift blocks completion until the original Worker confirms restoration", () => {
    // Arrange
    const originalPhysicalIdentity = parseWorkerPhysicalIdentity("A".repeat(43));
    const bootloaderEnumeration = parseWorkerEnumerationIdentity("B".repeat(43));
    const applicationEnumeration = parseWorkerEnumerationIdentity("C".repeat(43));
    const restoredEnumeration = parseWorkerEnumerationIdentity("E".repeat(43));
    let state = readyApplicationSession(
      originalPhysicalIdentity,
      bootloaderEnumeration,
      applicationEnumeration,
    );
    state = applyWorkerUsbSessionEvent(state, { type: "lease_started" });

    // Act
    state = applyWorkerUsbSessionEvent(state, {
      type: "identity_drift",
      observedPhysicalIdentity: parseWorkerPhysicalIdentity("D".repeat(43)),
    });
    const pending = state;
    state = applyWorkerUsbSessionEvent(state, {
      type: "restoration_confirmed",
      physicalIdentity: originalPhysicalIdentity,
      enumerationIdentity: restoredEnumeration,
    });

    // Assert
    expect(pending).toEqual({
      state: "restoration_pending",
      physicalIdentity: originalPhysicalIdentity,
      previousEnumerationIdentity: applicationEnumeration,
      reason: "identity_drift",
    });
    expect(state).toEqual({
      state: "application_ready",
      physicalIdentity: originalPhysicalIdentity,
      enumerationIdentity: restoredEnumeration,
      lease: "none",
    });
  });

  test("command-shaped evidence cannot change controller or lease state", () => {
    // Arrange
    let state = readyApplicationSession(
      parseWorkerPhysicalIdentity("A".repeat(43)),
      parseWorkerEnumerationIdentity("B".repeat(43)),
      parseWorkerEnumerationIdentity("C".repeat(43)),
    );
    state = applyWorkerUsbSessionEvent(state, { type: "lease_started" });

    // Act
    const observed = applyWorkerUsbSessionEvent(state, {
      type: "evidence_observed",
      category: "json_shaped_log",
    });

    // Assert
    expect(observed).toEqual(state);
    expect(observed).toMatchObject({ state: "application_ready", lease: "active" });
  });

  test.each(["control_lost", "response_lost"] as const)(
    "%s keeps public completion pending until restoration proof",
    (event) => {
      // Arrange
      const physicalIdentity = parseWorkerPhysicalIdentity("A".repeat(43));
      let state = readyApplicationSession(
        physicalIdentity,
        parseWorkerEnumerationIdentity("B".repeat(43)),
        parseWorkerEnumerationIdentity("C".repeat(43)),
      );
      state = applyWorkerUsbSessionEvent(state, { type: "lease_started" });

      // Act
      const pending = applyWorkerUsbSessionEvent(state, { type: event });

      // Assert
      expect(pending).toMatchObject({
        state: "restoration_pending",
        physicalIdentity,
        reason: event,
      });
    },
  );
});

function readyApplicationSession(
  physicalIdentity: ReturnType<typeof parseWorkerPhysicalIdentity>,
  bootloaderEnumeration: ReturnType<typeof parseWorkerEnumerationIdentity>,
  applicationEnumeration: ReturnType<typeof parseWorkerEnumerationIdentity>,
) {
  let state = initialWorkerUsbSession();
  state = applyWorkerUsbSessionEvent(state, {
    type: "bootloader_admitted",
    physicalIdentity,
    enumerationIdentity: bootloaderEnumeration,
  });
  state = applyWorkerUsbSessionEvent(state, {
    type: "application_observed",
    physicalIdentity,
    enumerationIdentity: applicationEnumeration,
    profile: parseWorkerUsbTransportProfile(exactProfile()),
  });
  return applyWorkerUsbSessionEvent(state, { type: "application_admitted" });
}

function exactProfile() {
  return {
    profile: "bwg-worker-usb/0.1",
    bootloader: {
      controller: "usb_serial_jtag",
      purpose: "flash_debug_only",
      acceptsWorkerController: false,
    },
    application: {
      controller: "tinyusb_composite",
      descriptor: {
        configurationValue: 1,
        control: {
          interfaceNumber: 0,
          alternateSetting: 0,
          classCode: 255,
          subclassCode: 66,
          protocolCode: 1,
          endpointOut: 1,
          endpointIn: 1,
          transferType: "bulk",
        },
        evidence: {
          communicationInterfaceNumber: 1,
          dataInterfaceNumber: 2,
          notificationEndpointIn: 2,
          dataEndpointOut: 3,
          dataEndpointIn: 3,
          hostWritesAccepted: false,
        },
      },
      functions: [
        {
          role: "worker_control",
          usbClass: "vendor_specific",
          browserTransport: "web_usb",
          direction: "bidirectional",
          content: "controller_frames_only",
        },
        {
          role: "worker_evidence",
          usbClass: "cdc_acm",
          browserTransport: "none",
          direction: "device_to_host",
          content: "redacted_observations_only",
        },
      ],
    },
    reacquisition: {
      physicalIdentity: "must_match",
      enumerationIdentity: "must_change",
      identityDrift: "restoration_pending",
    },
  };
}
