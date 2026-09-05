import type {
  WorkerController,
  WorkerControllerDisconnectReason,
  WorkerRestorationReason,
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
export type WorkerSerialQualificationHook = {
  suppressHeartbeats: boolean;
  prepareScope?: () => Promise<WorkerContinuityScope>;
};

export type WorkerSerialInternalOptions = {
  runtime: WorkerSerialBrowserRuntime;
  continuity?: WorkerContinuityAccess;
};
