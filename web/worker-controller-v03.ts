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
import type { WorkerUsbApplicationDescriptor } from "./worker-usb-profile";
import { WORKER_USB_V02_PROFILE_VERSION } from "./worker-usb-v02-profile";

/** Possession-bound production Controller profile over Worker USB 0.2. */
export const WORKER_CONTROLLER_V03_PROTOCOL_VERSION = "bwg-worker-controller/0.3" as const;

/** Strict signed possession-bound Reference Firmware capability. */
export type WorkerControllerCapabilitiesV03 = SignedWorkerControllerCapabilities<
  typeof WORKER_CONTROLLER_V03_PROTOCOL_VERSION,
  typeof WORKER_USB_V02_PROFILE_VERSION
>;
/** Update Authority claims binding Controller 0.3 to Worker USB 0.2. */
export type WorkerControllerCapabilityClaims = SignedCapabilityClaims<
  typeof WORKER_CONTROLLER_V03_PROTOCOL_VERSION,
  typeof WORKER_USB_V02_PROFILE_VERSION
>;
/** Compact Update Authority proof for the exact Controller 0.3 capability. */
export type WorkerControllerCapabilityAttestation = SignedCapabilityAttestation<
  typeof WORKER_CONTROLLER_V03_PROTOCOL_VERSION,
  typeof WORKER_USB_V02_PROFILE_VERSION
>;
/** Controller 0.3 specialization of one bounded authenticated Work Lease. */
export type WorkerLeaseGrantV03 = VersionedWorkerLeaseGrant<
  typeof WORKER_CONTROLLER_V03_PROTOCOL_VERSION
>;
/** Controller 0.3 specialization of one exact Work Lease renewal. */
export type WorkerLeaseRenewalV03 = VersionedWorkerLeaseRenewal<
  typeof WORKER_CONTROLLER_V03_PROTOCOL_VERSION
>;
/** Metadata-only Controller 0.3 mining and restoration state. */
export type WorkerControllerStatusV03 = VersionedWorkerControllerStatus<
  typeof WORKER_CONTROLLER_V03_PROTOCOL_VERSION
>;
/** Controller 0.3 specialization of the stable high-level Controller interface. */
export type WorkerControllerV03 = WorkerControllerContract<
  WorkerControllerCapabilitiesV03,
  WorkerLeaseGrantV03,
  WorkerLeaseRenewalV03,
  WorkerControllerStatusV03
>;

const profile = {
  protocolVersion: WORKER_CONTROLLER_V03_PROTOCOL_VERSION,
  transportProfile: WORKER_USB_V02_PROFILE_VERSION,
  label: "Worker Controller 0.3",
};

/** Parses strict Controller 0.3 capability bytes. */
export function parseWorkerControllerCapabilitiesV03(
  input: unknown,
): WorkerControllerCapabilitiesV03 {
  return parseSignedWorkerControllerCapabilities(input, profile);
}

/** Verifies the Update Authority signature and exact USB descriptor binding. */
export function verifyWorkerControllerCapabilityV03(
  capability: WorkerControllerCapabilitiesV03,
  descriptor: WorkerUsbApplicationDescriptor,
  trustedKeys: readonly unknown[],
): Promise<WorkerControllerCapabilitiesV03> {
  return verifySignedWorkerControllerCapability(capability, descriptor, trustedKeys, profile);
}

/** Parses a Controller 0.3 grant through the shared bounded Work Lease semantics. */
export function parseWorkerLeaseGrantV03(input: unknown): WorkerLeaseGrantV03 {
  return parseVersionedWorkerLeaseGrant(input, profile);
}

/** Parses a Controller 0.3 renewal through the shared bounded Work Lease semantics. */
export function parseWorkerLeaseRenewalV03(input: unknown): WorkerLeaseRenewalV03 {
  return parseVersionedWorkerLeaseRenewal(input, profile);
}

/** Parses strict metadata-only Controller 0.3 status. */
export function parseWorkerControllerStatusV03(input: unknown): WorkerControllerStatusV03 {
  return parseVersionedWorkerControllerStatus(input, profile);
}
