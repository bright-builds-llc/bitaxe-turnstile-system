import {
  parseWorkerControllerStatus,
  type WorkerControllerStatus,
} from "./worker-controller";
import { serialFailure } from "./worker-serial";
import type { WorkerPreservation } from "./worker-preservation";

/** Checks the preservation key against possession and strips all private digests from public status. */
export function publicWorkerSerialStatus(
  input: unknown,
  maybeKeySha256: string | undefined,
  maybeObserve: ((value: WorkerPreservation) => void) | undefined,
  maybeObserveStatus?: (value: WorkerControllerStatus) => void,
): WorkerControllerStatus {
  const status = parseWorkerControllerStatus(input);
  const { preservation: maybePreservation, ...publicStatus } = status;
  if (maybePreservation) {
    if (
      !maybeKeySha256 ||
      maybePreservation.device_identity_sha256 !== maybeKeySha256
    )
      throw serialFailure("preservation_identity");
    maybeObserve?.(maybePreservation);
  }
  maybeObserveStatus?.(publicStatus);
  return publicStatus;
}
