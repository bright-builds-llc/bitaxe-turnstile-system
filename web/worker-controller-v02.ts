import type { WorkerControllerContract } from "./worker-controller";
import {
  parseSignedWorkerControllerCapabilities,
  parseVersionedWorkerControllerStatus,
  parseVersionedWorkerLeaseGrant,
  parseVersionedWorkerLeaseRenewal,
  verifySignedWorkerControllerCapability,
  type SignedWorkerControllerCapabilities,
  type VersionedWorkerControllerStatus,
  type VersionedWorkerLeaseGrant,
  type VersionedWorkerLeaseRenewal,
  type WorkerControllerCapabilityAttestation as SignedCapabilityAttestation,
  type WorkerControllerCapabilityClaims as SignedCapabilityClaims,
} from "./worker-controller-signed-profile";
import {
  WORKER_USB_PROFILE_VERSION,
  type WorkerUsbApplicationDescriptor,
} from "./worker-usb-profile";

/** Wire profile used by the Controller-only separated USB compatibility transport. */
export const WORKER_CONTROLLER_V02_PROTOCOL_VERSION = "bwg-worker-controller/0.2" as const;

/** Strict signed Reference Firmware capability returned by Controller 0.2. */
export type WorkerControllerCapabilitiesV02 = SignedWorkerControllerCapabilities<
  typeof WORKER_CONTROLLER_V02_PROTOCOL_VERSION,
  typeof WORKER_USB_PROFILE_VERSION
>;
/** Update Authority claims binding Controller 0.2 to Worker USB 0.1. */
export type WorkerControllerCapabilityClaims = SignedCapabilityClaims<
  typeof WORKER_CONTROLLER_V02_PROTOCOL_VERSION,
  typeof WORKER_USB_PROFILE_VERSION
>;
/** Compact Update Authority proof for the exact Controller 0.2 capability. */
export type WorkerControllerCapabilityAttestation = SignedCapabilityAttestation<
  typeof WORKER_CONTROLLER_V02_PROTOCOL_VERSION,
  typeof WORKER_USB_PROFILE_VERSION
>;
/** Controller 0.2 specialization of one bounded authenticated Work Lease. */
export type WorkerLeaseGrantV02 = VersionedWorkerLeaseGrant<
  typeof WORKER_CONTROLLER_V02_PROTOCOL_VERSION
>;
/** Controller 0.2 specialization of one exact Work Lease renewal. */
export type WorkerLeaseRenewalV02 = VersionedWorkerLeaseRenewal<
  typeof WORKER_CONTROLLER_V02_PROTOCOL_VERSION
>;
/** Metadata-only Controller 0.2 mining and restoration state. */
export type WorkerControllerStatusV02 = VersionedWorkerControllerStatus<
  typeof WORKER_CONTROLLER_V02_PROTOCOL_VERSION
>;
/** Controller 0.2 specialization of the stable high-level Controller interface. */
export type WorkerControllerV02 = WorkerControllerContract<
  WorkerControllerCapabilitiesV02,
  WorkerLeaseGrantV02,
  WorkerLeaseRenewalV02,
  WorkerControllerStatusV02
>;

const profile = {
  protocolVersion: WORKER_CONTROLLER_V02_PROTOCOL_VERSION,
  transportProfile: WORKER_USB_PROFILE_VERSION,
  label: "Worker Controller 0.2",
};

/** Parses strict Controller 0.2 capability bytes. */
export function parseWorkerControllerCapabilitiesV02(
  input: unknown,
): WorkerControllerCapabilitiesV02 {
  return parseSignedWorkerControllerCapabilities(input, profile);
}

/** Verifies the Update Authority signature and exact USB descriptor binding. */
export function verifyWorkerControllerCapabilityV02(
  capability: WorkerControllerCapabilitiesV02,
  descriptor: WorkerUsbApplicationDescriptor,
  trustedKeys: readonly unknown[],
): Promise<WorkerControllerCapabilitiesV02> {
  return verifySignedWorkerControllerCapability(capability, descriptor, trustedKeys, profile);
}

/** Parses a Controller 0.2 grant through the shared bounded Work Lease semantics. */
export function parseWorkerLeaseGrantV02(input: unknown): WorkerLeaseGrantV02 {
  return parseVersionedWorkerLeaseGrant(input, profile);
}

/** Parses a Controller 0.2 renewal through the shared bounded Work Lease semantics. */
export function parseWorkerLeaseRenewalV02(input: unknown): WorkerLeaseRenewalV02 {
  return parseVersionedWorkerLeaseRenewal(input, profile);
}

/** Parses strict metadata-only Controller 0.2 status. */
export function parseWorkerControllerStatusV02(input: unknown): WorkerControllerStatusV02 {
  return parseVersionedWorkerControllerStatus(input, profile);
}
