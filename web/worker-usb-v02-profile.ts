import {
  parseWorkerUsbTransportProfile,
  type WorkerControlFunction,
  type WorkerEvidenceFunction,
  type WorkerUsbApplicationDescriptor,
  type WorkerUsbTransportProfile,
} from "./worker-usb-profile";

/** Possession-capable application transport bound by Controller 0.3. */
export const WORKER_USB_V02_PROFILE_VERSION = "bwg-worker-usb/0.2" as const;

/** USB 0.2 deliberately preserves the exact USB 0.1 physical descriptor. */
export type WorkerUsbApplicationDescriptorV02 = WorkerUsbApplicationDescriptor;

/** USB 0.2 control function carrying possession or Controller frames and never logs. */
export type WorkerControlFunctionV02 = Omit<WorkerControlFunction, "content"> & {
  content: "possession_and_controller_frames_only";
};

/** Exact possession-bound TinyUSB topology and Device Identity reacquisition policy. */
export type WorkerUsbTransportProfileV02 = Omit<
  WorkerUsbTransportProfile,
  "profile" | "application" | "reacquisition"
> & {
  profile: typeof WORKER_USB_V02_PROFILE_VERSION;
  application: Omit<WorkerUsbTransportProfile["application"], "functions"> & {
    functions: readonly [WorkerControlFunctionV02, WorkerEvidenceFunction];
  };
  reacquisition: {
    physicalIdentity: "device_identity_possession";
    enumerationIdentity: "must_change";
    identityDrift: "restoration_pending";
  };
};

/** Parses USB 0.2 without widening or reinterpreting the strict USB 0.1 profile. */
export function parseWorkerUsbTransportProfileV02(input: unknown): WorkerUsbTransportProfileV02 {
  const value = record(input);
  const application = record(value.application);
  const reacquisition = record(value.reacquisition);
  if (!Array.isArray(application.functions) || application.functions.length !== 2) invalid();
  const control = record(application.functions[0]);
  if (
    value.profile !== WORKER_USB_V02_PROFILE_VERSION ||
    control.content !== "possession_and_controller_frames_only" ||
    reacquisition.physicalIdentity !== "device_identity_possession"
  ) {
    invalid();
  }
  const legacyInput = structuredClone(value);
  legacyInput.profile = "bwg-worker-usb/0.1";
  const legacyApplication = record(legacyInput.application);
  const legacyReacquisition = record(legacyInput.reacquisition);
  if (!Array.isArray(legacyApplication.functions)) invalid();
  const legacyControl = record(legacyApplication.functions[0]);
  legacyControl.content = "controller_frames_only";
  legacyReacquisition.physicalIdentity = "must_match";
  const parsed = parseWorkerUsbTransportProfile(legacyInput);
  return {
    ...parsed,
    profile: WORKER_USB_V02_PROFILE_VERSION,
    application: {
      ...parsed.application,
      functions: [
        {
          ...parsed.application.functions[0],
          content: "possession_and_controller_frames_only",
        },
        parsed.application.functions[1],
      ],
    },
    reacquisition: {
      physicalIdentity: "device_identity_possession",
      enumerationIdentity: "must_change",
      identityDrift: "restoration_pending",
    },
  };
}

function record(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) invalid();
  return input as Record<string, unknown>;
}

function invalid(): never {
  throw new Error("Worker USB 0.2 transport profile is invalid");
}
