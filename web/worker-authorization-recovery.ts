import { encodeBase64Url } from "./crypto-bytes";
import type { WorkerControllerStatus } from "./worker-controller";
import { parseWorkerPreservation, type WorkerPreservation } from "./worker-preservation";

export type WorkerAuthorizationRecovery = { schema: "worker-authorization-recovery-v1"; checkpointId: string; generation: number; matched: boolean | null };

/** Private post-work comparison, independent of the immutable pre-work baseline. */
export class WorkerAuthorizationRecoveryCheckpoint {
  #session = 0;
  #maybeStagedHash: string | undefined;
  #maybeCurrent: { hash: string; generation: number; session: number } | undefined;
  #maybeCheckpoint: { hash: string; session: number; public: WorkerAuthorizationRecovery } | undefined;
  beginSession(): void { this.#session++; this.#maybeStagedHash = undefined; this.#maybeCurrent = undefined; }
  observePreservation(value: WorkerPreservation): void { this.#maybeStagedHash = parseWorkerPreservation(value).authorization_high_water_sha256; }
  observeStatus(maybeStatus: WorkerControllerStatus | undefined): void {
    const maybeHash = this.#maybeStagedHash;
    this.#maybeStagedHash = undefined;
    this.#maybeCurrent = undefined;
    if (!maybeStatus) return;
    const maybeGeneration = maybeStatus.qualification?.generation;
    if (maybeHash && maybeGeneration !== undefined) this.#maybeCurrent = { hash: maybeHash, generation: maybeGeneration, session: this.#session };
    const checkpoint = this.#maybeCheckpoint;
    if (!checkpoint || this.#session <= checkpoint.session || checkpoint.public.matched === false) return;
    checkpoint.public.matched = maybeHash === checkpoint.hash && maybeGeneration === checkpoint.public.generation;
  }
  capture(maybeGeneration: number | undefined): void {
    const current = this.#maybeCurrent;
    if (this.#maybeCheckpoint || !current || current.session !== this.#session || current.generation !== maybeGeneration || !Number.isSafeInteger(maybeGeneration) || Number(maybeGeneration) < 1 || Number(maybeGeneration) > 0xffff_ffff) throw new Error("authorization_recovery_capture");
    this.#maybeCheckpoint = { hash: current.hash, session: this.#session,
      public: { schema: "worker-authorization-recovery-v1", checkpointId: encodeBase64Url(crypto.getRandomValues(new Uint8Array(16))), generation: current.generation, matched: null } };
  }
  clearForResume(sealed: boolean): void {
    if (this.#maybeCheckpoint && !sealed) throw new Error("authorization_recovery_unsealed");
    this.#maybeCheckpoint = undefined;
  }
  maybePublicState(): WorkerAuthorizationRecovery | undefined { return this.#maybeCheckpoint ? { ...this.#maybeCheckpoint.public } : undefined; }
}
