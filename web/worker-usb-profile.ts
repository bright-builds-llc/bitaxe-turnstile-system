/** Exact application transport profile shared by client and Reference Firmware. */
export const WORKER_USB_PROFILE_VERSION = "bwg-worker-usb/0.1" as const;

/** Exact bootloader/application topology and reacquisition policy. */
export type WorkerUsbTransportProfile = {
  profile: typeof WORKER_USB_PROFILE_VERSION;
  bootloader: {
    controller: "usb_serial_jtag";
    purpose: "flash_debug_only";
    acceptsWorkerController: false;
  };
  application: {
    controller: "tinyusb_composite";
    descriptor: WorkerUsbApplicationDescriptor;
    functions: readonly [WorkerControlFunction, WorkerEvidenceFunction];
  };
  reacquisition: {
    physicalIdentity: "must_match";
    enumerationIdentity: "must_change";
    identityDrift: "restoration_pending";
  };
};

/** Exact TinyUSB interfaces and endpoints admitted for Reference Firmware. */
export type WorkerUsbApplicationDescriptor = {
  configurationValue: 1;
  control: {
    interfaceNumber: 0;
    alternateSetting: 0;
    classCode: 255;
    subclassCode: 66;
    protocolCode: 1;
    endpointOut: 1;
    endpointIn: 1;
    transferType: "bulk";
  };
  evidence: {
    communicationInterfaceNumber: 1;
    dataInterfaceNumber: 2;
    notificationEndpointIn: 2;
    dataEndpointOut: 3;
    dataEndpointIn: 3;
    hostWritesAccepted: false;
  };
};

/** Protocol-only bidirectional application control function. */
export type WorkerControlFunction = {
  role: "worker_control";
  usbClass: "vendor_specific";
  browserTransport: "web_usb";
  direction: "bidirectional";
  content: "controller_frames_only";
};

/** Receive-only redacted runtime evidence function. */
export type WorkerEvidenceFunction = {
  role: "worker_evidence";
  usbClass: "cdc_acm";
  browserTransport: "none";
  direction: "device_to_host";
  content: "redacted_observations_only";
};

declare const workerPhysicalIdentityBrand: unique symbol;
declare const workerEnumerationIdentityBrand: unique symbol;

/** Stable, redacted physical-Worker identity digest. */
export type WorkerPhysicalIdentity = string & {
  readonly [workerPhysicalIdentityBrand]: true;
};

/** Ephemeral USB enumeration identity digest. */
export type WorkerEnumerationIdentity = string & {
  readonly [workerEnumerationIdentityBrand]: true;
};

/** Closed transport lifecycle including restoration uncertainty. */
export type WorkerUsbSessionState =
  | { state: "unselected" }
  | {
      state: "bootloader_admitted";
      physicalIdentity: WorkerPhysicalIdentity;
      enumerationIdentity: WorkerEnumerationIdentity;
    }
  | {
      state: "application_reacquisition_required";
      physicalIdentity: WorkerPhysicalIdentity;
      previousEnumerationIdentity: WorkerEnumerationIdentity;
      enumerationIdentity: WorkerEnumerationIdentity;
    }
  | {
      state: "application_ready";
      physicalIdentity: WorkerPhysicalIdentity;
      enumerationIdentity: WorkerEnumerationIdentity;
      lease: "none" | "active";
    }
  | {
      state: "restoration_pending";
      physicalIdentity: WorkerPhysicalIdentity;
      previousEnumerationIdentity: WorkerEnumerationIdentity;
      reason: "identity_drift" | "control_lost" | "response_lost";
    };

/** Pure observations accepted by the transport lifecycle reducer. */
export type WorkerUsbSessionEvent =
  | {
      type: "bootloader_admitted";
      physicalIdentity: WorkerPhysicalIdentity;
      enumerationIdentity: WorkerEnumerationIdentity;
    }
  | {
      type: "application_observed";
      physicalIdentity: WorkerPhysicalIdentity;
      enumerationIdentity: WorkerEnumerationIdentity;
      profile: WorkerUsbTransportProfile;
    }
  | { type: "application_admitted" }
  | { type: "lease_started" }
  | {
      type: "identity_drift";
      observedPhysicalIdentity: WorkerPhysicalIdentity;
    }
  | {
      type: "restoration_confirmed";
      physicalIdentity: WorkerPhysicalIdentity;
      enumerationIdentity: WorkerEnumerationIdentity;
    }
  | { type: "evidence_observed"; category: "json_shaped_log" | "runtime_observation" }
  | { type: "control_lost" | "response_lost" };

/** Creates a session with no trusted physical or enumeration identity. */
export function initialWorkerUsbSession(): WorkerUsbSessionState {
  return { state: "unselected" };
}

/** Applies one strict transport observation without performing USB effects. */
export function applyWorkerUsbSessionEvent(
  state: WorkerUsbSessionState,
  event: WorkerUsbSessionEvent,
): WorkerUsbSessionState {
  if (state.state === "unselected" && event.type === "bootloader_admitted") {
    return {
      state: "bootloader_admitted",
      physicalIdentity: event.physicalIdentity,
      enumerationIdentity: event.enumerationIdentity,
    };
  }
  if (state.state === "bootloader_admitted" && event.type === "application_observed") {
    if (
      state.physicalIdentity !== event.physicalIdentity ||
      state.enumerationIdentity === event.enumerationIdentity ||
      event.profile.profile !== WORKER_USB_PROFILE_VERSION
    ) {
      throw new Error("Worker USB application reacquisition failed");
    }
    return {
      state: "application_reacquisition_required",
      physicalIdentity: state.physicalIdentity,
      previousEnumerationIdentity: state.enumerationIdentity,
      enumerationIdentity: event.enumerationIdentity,
    };
  }
  if (
    state.state === "application_reacquisition_required" &&
    event.type === "application_admitted"
  ) {
    return {
      state: "application_ready",
      physicalIdentity: state.physicalIdentity,
      enumerationIdentity: state.enumerationIdentity,
      lease: "none",
    };
  }
  if (
    state.state === "application_ready" &&
    state.lease === "none" &&
    event.type === "lease_started"
  ) {
    return { ...state, lease: "active" };
  }
  if (
    state.state === "application_ready" &&
    state.lease === "active" &&
    event.type === "identity_drift" &&
    event.observedPhysicalIdentity !== state.physicalIdentity
  ) {
    return {
      state: "restoration_pending",
      physicalIdentity: state.physicalIdentity,
      previousEnumerationIdentity: state.enumerationIdentity,
      reason: "identity_drift",
    };
  }
  if (
    state.state === "application_ready" &&
    (event.type === "control_lost" || event.type === "response_lost")
  ) {
    return {
      state: "restoration_pending",
      physicalIdentity: state.physicalIdentity,
      previousEnumerationIdentity: state.enumerationIdentity,
      reason: event.type,
    };
  }
  if (
    state.state === "restoration_pending" &&
    event.type === "restoration_confirmed" &&
    event.physicalIdentity === state.physicalIdentity &&
    event.enumerationIdentity !== state.previousEnumerationIdentity
  ) {
    return {
      state: "application_ready",
      physicalIdentity: state.physicalIdentity,
      enumerationIdentity: event.enumerationIdentity,
      lease: "none",
    };
  }
  if (state.state === "application_ready" && event.type === "evidence_observed") {
    return state;
  }
  throw new Error("Worker USB session transition is invalid");
}

/** Parses one stable physical-Worker digest without exposing raw USB identity. */
export function parseWorkerPhysicalIdentity(value: unknown): WorkerPhysicalIdentity {
  return parseIdentity(value, "Worker physical identity") as WorkerPhysicalIdentity;
}

/** Parses one enumeration-epoch digest without treating it as physical identity. */
export function parseWorkerEnumerationIdentity(value: unknown): WorkerEnumerationIdentity {
  return parseIdentity(value, "Worker enumeration identity") as WorkerEnumerationIdentity;
}

/** Reconstructs the exact separated USB topology and rejects role crossover. */
export function parseWorkerUsbTransportProfile(input: unknown): WorkerUsbTransportProfile {
  const profile = exactRecord(input, ["profile", "bootloader", "application", "reacquisition"]);
  const bootloader = exactRecord(profile.bootloader, [
    "controller",
    "purpose",
    "acceptsWorkerController",
  ]);
  const application = exactRecord(profile.application, ["controller", "descriptor", "functions"]);
  const reacquisition = exactRecord(profile.reacquisition, [
    "physicalIdentity",
    "enumerationIdentity",
    "identityDrift",
  ]);
  if (!Array.isArray(application.functions) || application.functions.length !== 2) {
    throw new Error("Worker USB transport profile is invalid");
  }
  const control = exactRecord(application.functions[0], [
    "role",
    "usbClass",
    "browserTransport",
    "direction",
    "content",
  ]);
  const evidence = exactRecord(application.functions[1], [
    "role",
    "usbClass",
    "browserTransport",
    "direction",
    "content",
  ]);
  const descriptor = parseWorkerUsbApplicationDescriptor(application.descriptor);
  if (
    profile.profile !== WORKER_USB_PROFILE_VERSION ||
    bootloader.controller !== "usb_serial_jtag" ||
    bootloader.purpose !== "flash_debug_only" ||
    bootloader.acceptsWorkerController !== false ||
    application.controller !== "tinyusb_composite" ||
    control.role !== "worker_control" ||
    control.usbClass !== "vendor_specific" ||
    control.browserTransport !== "web_usb" ||
    control.direction !== "bidirectional" ||
    control.content !== "controller_frames_only" ||
    evidence.role !== "worker_evidence" ||
    evidence.usbClass !== "cdc_acm" ||
    evidence.browserTransport !== "none" ||
    evidence.direction !== "device_to_host" ||
    evidence.content !== "redacted_observations_only" ||
    reacquisition.physicalIdentity !== "must_match" ||
    reacquisition.enumerationIdentity !== "must_change" ||
    reacquisition.identityDrift !== "restoration_pending"
  ) {
    throw new Error("Worker USB transport profile is invalid");
  }
  return {
    profile: WORKER_USB_PROFILE_VERSION,
    bootloader: {
      controller: "usb_serial_jtag",
      purpose: "flash_debug_only",
      acceptsWorkerController: false,
    },
    application: {
      controller: "tinyusb_composite",
      descriptor,
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

/** Reconstructs the exact TinyUSB interface and endpoint allocation. */
export function parseWorkerUsbApplicationDescriptor(
  input: unknown,
): WorkerUsbApplicationDescriptor {
  const descriptor = exactRecord(input, ["configurationValue", "control", "evidence"]);
  const control = exactRecord(descriptor.control, [
    "interfaceNumber",
    "alternateSetting",
    "classCode",
    "subclassCode",
    "protocolCode",
    "endpointOut",
    "endpointIn",
    "transferType",
  ]);
  const evidence = exactRecord(descriptor.evidence, [
    "communicationInterfaceNumber",
    "dataInterfaceNumber",
    "notificationEndpointIn",
    "dataEndpointOut",
    "dataEndpointIn",
    "hostWritesAccepted",
  ]);
  if (
    descriptor.configurationValue !== 1 ||
    control.interfaceNumber !== 0 ||
    control.alternateSetting !== 0 ||
    control.classCode !== 255 ||
    control.subclassCode !== 66 ||
    control.protocolCode !== 1 ||
    control.endpointOut !== 1 ||
    control.endpointIn !== 1 ||
    control.transferType !== "bulk" ||
    evidence.communicationInterfaceNumber !== 1 ||
    evidence.dataInterfaceNumber !== 2 ||
    evidence.notificationEndpointIn !== 2 ||
    evidence.dataEndpointOut !== 3 ||
    evidence.dataEndpointIn !== 3 ||
    evidence.hostWritesAccepted !== false
  ) {
    throw new Error("Worker USB application descriptor is invalid");
  }
  return {
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
  };
}

function exactRecord(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Worker USB transport profile is invalid");
  }
  const value = input as Record<string, unknown>;
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    throw new Error("Worker USB transport profile is invalid");
  }
  return value;
}

function parseIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}
