import type { WorkerQualificationLedger } from "./worker-qualification-attempt";
import type { WorkerReadInterruption } from "./worker-read-interruption";
import type { BrowserSerialTrace, WorkerBrowserSerialTrace } from "./worker-browser-serial-trace";
import type { DeviceSerialTrace } from "./worker-serial-trace-export";
import type { WorkerMiningInterruption } from "./worker-mining-interruption";
import type { QualificationCoolingAction, WorkerCoolingProof, WorkerCoolingBaseline } from "./worker-qualification-cooling";
import type { WorkLeaseAuthorityTrust } from "./worker-lease-authorization";
import type { WorkerBudgetReview } from "./worker-budget-review";
import type { WorkerSerialFailureCategory } from "./worker-serial-errors";
import type { WorkerSerialDiagnostic } from "./worker-serial-diagnostics";
import type { WorkerPreservation } from "./worker-preservation";
import type {
  WorkerController,
  WorkerControllerDisconnectReason,
  WorkerRestorationReason,
  WorkerControllerStatus,
} from "./worker-controller";
import type { WorkerLeaseAuthorizationContextProvider } from "./worker-lease-authorization";
import type {
  WorkerContinuityScope,
  WorkerContinuityAccess,
} from "./worker-continuity-store";
import type { WorkerSerialBrowserRuntime } from "./webserial-worker-port";

export type Ack = {
  sessionId: string;
  hostNonce: string;
  deviceNonce: string;
  firmwareSourceCommit: string;
  appElfSha256: string;
};
export type PendingResponse = {
  requestId: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
};
export type WebSerialWorkerControllerInput = {
  deviceFilter: { usbVendorId: number; usbProductId: number };
  trustedUpdateKeys: readonly unknown[];
  continuityScope: WorkerContinuityScope;
  expectedFirmwareSourceCommit?: string;
  expectedAppElfSha256?: string;
};
export interface WebSerialWorkerController
  extends WorkerController,
  WorkerLeaseAuthorizationContextProvider {
  requestPermission(): Promise<{ status: "ready"; recovered: boolean }>;
  subscribeDisconnect(
    listener: (reason: WorkerControllerDisconnectReason) => Promise<void>,
  ): () => void;
  close(reason?: WorkerRestorationReason): Promise<void>;
  /** Qualification only; requires the explicit qualification hook. */
  rejectStartForRecoveryTest(trust: WorkLeaseAuthorityTrust): Promise<{ rejected: true; error: "authentication_failed" }>;
  qualificationCooling(action: QualificationCoolingAction): Promise<WorkerCoolingProof | WorkerCoolingBaseline>;
  qualificationAttemptReview(): Promise<WorkerQualificationLedger>;
  /** Qualification only: interrupt a consumed no-mining status with a still-pending reply. */
  interruptPendingStatusForQualification(): Promise<WorkerReadInterruption>;
  qualificationAbruptDisconnect(): Promise<WorkerMiningInterruption>;
  exportBrowserSerialTrace(): BrowserSerialTrace;
  deviceSerialTraceReview(): Promise<DeviceSerialTrace>;
  acceptanceBudgetReview(campaignId: string): Promise<WorkerBudgetReview>;
  transportProbe(maybePaddingBytes?: number): Promise<{
    paddingBytes: number;
    requestPayloadBytes: number;
    responsePayloadBytes: number;
  }>;
}
/** Qualification-only suppression can revoke liveness; it cannot grant or extend work. */
export const workerSerialQualificationHook = Symbol(
  "workerSerialQualificationHook",
);
export type WorkerSerialAdmissionStage = "ownership" | "permission" | "device_filter" | "scope" | "opening" | "hello" | "manifest_identity" | "capability" | "possession" | "baseline" | "continuity" | "cleanup";
export type WorkerSerialQualificationHook = {
  maybeTraceHistory?: WorkerBrowserSerialTrace;
  maybeObserveHelloRecovery?: (value: { discardedRecords: number; discardedReplies: number; discardedBytes: number }) => void;
  maybeObserveSerialFailure?: (category: WorkerSerialFailureCategory) => void;
  maybeObserveDiagnostic?: (value: WorkerSerialDiagnostic) => void;
  maybeObserveSerialOwnership?: (released: boolean) => void;
  maybeObserveAdmissionFailure?: (stage: WorkerSerialAdmissionStage) => void;
  suppressHeartbeats: boolean;
  memoryOnlyContinuity?: boolean;
  prepareScope?: () => Promise<WorkerContinuityScope>;
  observePreservation?: (value: WorkerPreservation) => void;
  observeStatus?: (value: WorkerControllerStatus | undefined) => void;
};

export type WorkerSerialInternalOptions = {
  runtime: WorkerSerialBrowserRuntime;
  continuity?: WorkerContinuityAccess;
};
