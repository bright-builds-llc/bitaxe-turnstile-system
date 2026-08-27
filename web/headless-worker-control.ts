import type { ChallengeLifecycleState, HeadlessTransport } from "./headless-client.types";
import {
  parseWorkerControllerCapabilities,
  parseWorkerControllerStatus,
  type WorkerController,
  type WorkerControllerCapabilities,
  type WorkerControllerStatus,
  type WorkerLeaseGrant,
  type WorkerLeaseRenewal,
  type WorkerRestorationReason,
} from "./worker-controller";

export async function discoverWorker(
  controller: WorkerController,
): Promise<WorkerControllerCapabilities> {
  return parseWorkerControllerCapabilities(await controller.discover());
}

export async function startWorkerController(
  maybeController: WorkerController | undefined,
  maybeGrant: void | WorkerLeaseGrant,
  expectedChallengeId: string,
  transport: HeadlessTransport,
): Promise<void> {
  if (!maybeController) return;
  if (!maybeGrant) {
    await transport.pause();
    throw new Error("Authority transport did not return a Worker Lease");
  }
  try {
    if (maybeGrant.challengeId !== expectedChallengeId) {
      throw new Error("Worker Lease does not match the active Work Challenge");
    }
    validatedMiningStatus(
      await maybeController.startLease(maybeGrant),
      maybeGrant.leaseId,
      expectedChallengeId,
    );
  } catch (error) {
    await rollbackControllerOperation(error, maybeController, transport);
  }
}

export async function renewWorkerController(
  controller: WorkerController,
  renewAuthorityLease: () => Promise<WorkerLeaseRenewal>,
  expectedChallengeId: string,
  transport: HeadlessTransport,
): Promise<void> {
  try {
    const renewal = await renewAuthorityLease();
    validatedMiningStatus(
      await controller.renewLease(renewal),
      renewal.leaseId,
      expectedChallengeId,
    );
  } catch (error) {
    await rollbackControllerOperation(error, controller, transport);
  }
}

export async function stopWorkerController(
  maybeController: WorkerController | undefined,
  command: "pause" | "cancel",
  transport: HeadlessTransport,
): Promise<void> {
  if (!maybeController) {
    await transport[command]();
    return;
  }
  const [controllerResult, authorityResult] = await Promise.allSettled([
    maybeController[command](),
    transport[command](),
  ]);
  const errors: unknown[] = [];
  collectRestorationResult(
    controllerResult,
    command === "pause" ? "paused" : "cancelled",
    errors,
  );
  if (authorityResult.status === "rejected") errors.push(authorityResult.reason);
  if (errors.length > 0) throwCollectedErrors(errors, "Worker and Authority stop failed");
}

export async function shutdownWorkerController(
  maybeController: WorkerController | undefined,
  reason: WorkerRestorationReason,
  transport: HeadlessTransport,
): Promise<void> {
  if (!maybeController) {
    await transport.pause();
    return;
  }
  const [controllerResult, authorityResult] = await Promise.allSettled([
    maybeController.restore(reason),
    transport.pause(),
  ]);
  const errors: unknown[] = [];
  collectRestorationResult(controllerResult, reason, errors);
  if (authorityResult.status === "rejected") errors.push(authorityResult.reason);
  if (errors.length > 0) throwCollectedErrors(errors, "Worker shutdown failed");
}

export async function restoreWorkerController(
  controller: WorkerController,
  reason: WorkerRestorationReason,
): Promise<void> {
  validatedRestorationStatus(await controller.restore(reason), reason);
}

export function validatedWorkerStatus(status: WorkerControllerStatus): WorkerControllerStatus {
  return parseWorkerControllerStatus(status);
}

export function restorationReason(
  state: ChallengeLifecycleState,
): WorkerRestorationReason | undefined {
  if (state === "satisfied" || state === "pass_issued") return "challenge_satisfied";
  if (state === "expired") return "challenge_expired";
  if (state === "cancelled") return "cancelled";
  return undefined;
}

function validatedMiningStatus(
  status: WorkerControllerStatus,
  leaseId: string,
  challengeId: string,
): WorkerControllerStatus {
  const parsed = validatedWorkerStatus(status);
  if (
    parsed.state !== "mining" ||
    parsed.lease.leaseId !== leaseId ||
    parsed.lease.challengeId !== challengeId
  ) {
    throw new Error("Worker Controller did not activate the expected Work Lease");
  }
  return parsed;
}

function validatedRestorationStatus(
  status: WorkerControllerStatus,
  reason: WorkerRestorationReason,
): WorkerControllerStatus {
  const parsed = validatedWorkerStatus(status);
  if (
    parsed.state !== "baseline" ||
    parsed.restoration.status !== "confirmed" ||
    parsed.restoration.reason !== reason
  ) {
    throw new Error("Worker Controller did not confirm Mining Baseline restoration");
  }
  return parsed;
}

function collectRestorationResult(
  result: PromiseSettledResult<WorkerControllerStatus>,
  reason: WorkerRestorationReason,
  errors: unknown[],
): void {
  if (result.status === "rejected") {
    errors.push(result.reason);
    return;
  }
  try {
    validatedRestorationStatus(result.value, reason);
  } catch (error) {
    errors.push(error);
  }
}

async function rollbackControllerOperation(
  originalError: unknown,
  controller: WorkerController,
  transport: HeadlessTransport,
): Promise<never> {
  const [controllerResult, authorityResult] = await Promise.allSettled([
    controller.restore("control_failed"),
    transport.pause(),
  ]);
  const errors = [originalError];
  collectRestorationResult(controllerResult, "control_failed", errors);
  if (authorityResult.status === "rejected") errors.push(authorityResult.reason);
  throwCollectedErrors(errors, "Worker admission rollback failed");
}

function throwCollectedErrors(errors: unknown[], message: string): never {
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, message);
}
