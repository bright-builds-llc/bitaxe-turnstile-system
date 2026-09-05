import type { WorkerControllerContract } from "./worker-controller-semantics";
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
import type { WorkerSerialManifest } from "./worker-serial";
import { WORKER_SERIAL_PROFILE } from "./worker-serial";

/** Possession-bound production Controller profile over Worker Serial 0.1. */
export const WORKER_CONTROLLER_PROTOCOL_VERSION = "bwg-worker-controller/0.4" as const;

/** Strict signed possession-bound Reference Firmware capability. */
export type WorkerControllerCapabilities = SignedWorkerControllerCapabilities<
  typeof WORKER_CONTROLLER_PROTOCOL_VERSION,
  typeof WORKER_SERIAL_PROFILE
>;
/** Update Authority claims binding Controller 0.4 to Worker Serial 0.1. */
export type WorkerControllerCapabilityClaims = SignedCapabilityClaims<
  typeof WORKER_CONTROLLER_PROTOCOL_VERSION,
  typeof WORKER_SERIAL_PROFILE
>;
/** Compact Update Authority proof for the exact Controller 0.4 capability. */
export type WorkerControllerCapabilityAttestation = SignedCapabilityAttestation<
  typeof WORKER_CONTROLLER_PROTOCOL_VERSION,
  typeof WORKER_SERIAL_PROFILE
>;
/** Controller 0.4 specialization of one bounded authenticated Work Lease. */
export type WorkerLeaseGrant = VersionedWorkerLeaseGrant<
  typeof WORKER_CONTROLLER_PROTOCOL_VERSION
>;
/** Controller 0.4 specialization of one exact Work Lease renewal. */
export type WorkerLeaseRenewal = VersionedWorkerLeaseRenewal<
  typeof WORKER_CONTROLLER_PROTOCOL_VERSION
>;
/** Metadata-only Controller 0.4 mining and restoration state. */
export type WorkerControllerStatus = VersionedWorkerControllerStatus<
  typeof WORKER_CONTROLLER_PROTOCOL_VERSION
>;
/** Controller 0.4 specialization of the stable high-level Controller interface. */
export type WorkerController = WorkerControllerContract<
  WorkerControllerCapabilities,
  WorkerLeaseGrant,
  WorkerLeaseRenewal,
  WorkerControllerStatus
>;

const profile = {
  protocolVersion: WORKER_CONTROLLER_PROTOCOL_VERSION,
  transportProfile: WORKER_SERIAL_PROFILE,
  label: "Worker Controller 0.4",
};

/** Parses strict Controller 0.4 capability bytes. */
export function parseWorkerControllerCapabilities(
  input: unknown,
): WorkerControllerCapabilities {
  return parseSignedWorkerControllerCapabilities(input, profile);
}

/** Verifies the Update Authority signature and exact USB manifest binding. */
export function verifyWorkerControllerCapability(
  capability: WorkerControllerCapabilities,
  manifest: WorkerSerialManifest,
  trustedKeys: readonly unknown[],
): Promise<WorkerControllerCapabilities> {
  return verifySignedWorkerControllerCapability(capability, manifest, trustedKeys, profile);
}

/** Parses a Controller 0.4 grant through the shared bounded Work Lease semantics. */
export function parseWorkerLeaseGrant(input: unknown): WorkerLeaseGrant {
  return parseVersionedWorkerLeaseGrant(input, profile);
}

/** Parses a Controller 0.4 renewal through the shared bounded Work Lease semantics. */
export function parseWorkerLeaseRenewal(input: unknown): WorkerLeaseRenewal {
  return parseVersionedWorkerLeaseRenewal(input, profile);
}

/** Parses strict metadata-only Controller 0.4 status. */
export function parseWorkerControllerStatus(input: unknown): WorkerControllerStatus {
  return parseVersionedWorkerControllerStatus(input, profile);
}

export { MAXIMUM_WORK_LEASE_MILLISECONDS, MAXIMUM_RENEW_AFTER_MILLISECONDS, parseWorkerRestorationReason } from "./worker-controller-semantics";
export type { WorkerControllerContract, WorkerControllerDisconnectReason, WorkerRestorationReason, WorkerAcceptanceCampaign } from "./worker-controller-semantics";

export { parseWorkerQualification, type WorkerQualification } from "./worker-qualification";
