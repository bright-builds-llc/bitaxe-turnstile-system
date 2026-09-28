import { encodeBase64Url } from "./crypto-bytes";
import type { WorkerControllerStatus } from "./worker-controller";
import { parseWorkerPreservation, type WorkerPreservation } from "./worker-preservation";

type Observation = { hash: string; generation: number; session: number; revision: number; state: WorkerControllerStatus["state"]; restored: boolean };
export type AuthorizationObservationToken = Readonly<{ session: number; revision: number }>;

export type WorkerAuthorizationRecovery = { schema: "worker-authorization-recovery-v1"; checkpointId: string; generation: number; matched: boolean | null };

/** Private post-work comparison, independent of the immutable pre-work baseline. */
export class WorkerAuthorizationRecoveryCheckpoint {
  #session = 0;
  #maybeStagedHash: string | undefined;
  #revision = 0;
  #maybeCurrent: Observation | undefined;
  #maybeNormalExpected: Observation | undefined;
  #maybeAuthorization: AuthorizationObservationToken | undefined;
  #normalInvalid = false;
  #maybeCheckpoint: { hash: string; session: number; public: WorkerAuthorizationRecovery } | undefined;
  beginSession(): void { this.#session++; this.#maybeStagedHash = undefined; this.#maybeCurrent = undefined; }
  observePreservation(value: WorkerPreservation): void { this.#maybeStagedHash = parseWorkerPreservation(value).authorization_high_water_sha256; }
  observeStatus(maybeStatus: WorkerControllerStatus | undefined): void {
    this.#revision++;
    const maybeHash = this.#maybeStagedHash;
    this.#maybeStagedHash = undefined;
    this.#maybeCurrent = undefined;
    if (!maybeStatus) return;
    const maybeGeneration = maybeStatus.qualification?.generation;
    if (maybeHash && maybeGeneration !== undefined) this.#maybeCurrent = { hash: maybeHash, generation: maybeGeneration, session: this.#session, revision: this.#revision, state: maybeStatus.state, restored: maybeStatus.state === "baseline" && maybeStatus.restoration.status === "confirmed" };
    if (this.#maybeNormalExpected && !this.#maybeAuthorization && !this.#matchesCurrent(this.#maybeNormalExpected)) this.#normalInvalid = true;
    const checkpoint = this.#maybeCheckpoint;
    if (!checkpoint || this.#session <= checkpoint.session || checkpoint.public.matched === false) return;
    checkpoint.public.matched = maybeHash === checkpoint.hash && maybeGeneration === checkpoint.public.generation;
  }
  #matchesCurrent(expected: Observation): boolean {
    return this.#maybeCurrent?.session === expected.session && this.#maybeCurrent.hash === expected.hash && this.#maybeCurrent.generation === expected.generation;
  }
  beginAuthorizedOperation(): AuthorizationObservationToken {
    if (this.#maybeCheckpoint || this.#maybeAuthorization || this.#normalInvalid || (this.#maybeNormalExpected && !this.#matchesCurrent(this.#maybeNormalExpected))) throw new Error("authorization_recovery_boundary");
    const token = Object.freeze({ session: this.#session, revision: this.#revision }); this.#maybeAuthorization = token; return token;
  }
  completeAuthorizedOperation(token: AuthorizationObservationToken): void {
    const current = this.#maybeCurrent;
    if (token !== this.#maybeAuthorization || !current || current.session !== token.session || current.revision <= token.revision || current.state !== "mining" ||
      this.#normalInvalid || !Number.isSafeInteger(current.generation) || current.generation < 1 || current.generation > 0xffff_ffff ||
      (this.#maybeNormalExpected && current.generation !== this.#maybeNormalExpected.generation)) throw new Error("authorization_recovery_boundary");
    this.#maybeNormalExpected = { ...current }; this.#maybeAuthorization = undefined;
  }
  cancelAuthorizedOperation(): void { this.#maybeAuthorization = undefined; this.#normalInvalid = true; }
  /** Restore must confirm a fresh unchanged observation from the known authorization response. */
  captureNormalStop(): void {
    if (this.#maybeCheckpoint) {
      const current = this.#maybeCurrent, checkpoint = this.#maybeCheckpoint;
      if (!current?.restored || current.hash !== checkpoint.hash || current.generation !== checkpoint.public.generation || checkpoint.public.matched === false) throw new Error("authorization_recovery_normal_stop");
      return;
    }
    if (!this.#maybeNormalExpected) return;
    const expected = this.#maybeNormalExpected, current = this.#maybeCurrent;
    if (this.#normalInvalid || this.#maybeAuthorization || !current?.restored || !this.#matchesCurrent(expected) || current.revision <= expected.revision) throw new Error("authorization_recovery_normal_stop");
    this.capture(expected.generation);
  }
  capture(maybeGeneration: number | undefined): void {
    const current = this.#maybeCurrent;
    if (this.#normalInvalid || (this.#maybeNormalExpected && !this.#matchesCurrent(this.#maybeNormalExpected)) || this.#maybeCheckpoint || !current || current.session !== this.#session || current.generation !== maybeGeneration || !Number.isSafeInteger(maybeGeneration) || Number(maybeGeneration) < 1 || Number(maybeGeneration) > 0xffff_ffff) throw new Error("authorization_recovery_capture");
    this.#maybeCheckpoint = { hash: current.hash, session: this.#session,
      public: { schema: "worker-authorization-recovery-v1", checkpointId: encodeBase64Url(crypto.getRandomValues(new Uint8Array(16))), generation: current.generation, matched: null } };
    this.#maybeNormalExpected = undefined;
  }
  clearForResume(sealed: boolean): void {
    if ((this.#maybeCheckpoint || this.#maybeNormalExpected || this.#maybeAuthorization || this.#normalInvalid) && !sealed) throw new Error("authorization_recovery_unsealed");
    this.#maybeCheckpoint = undefined; this.#maybeNormalExpected = undefined; this.#maybeAuthorization = undefined; this.#normalInvalid = false;
  }
  maybePublicState(): WorkerAuthorizationRecovery | undefined { return this.#maybeCheckpoint ? { ...this.#maybeCheckpoint.public } : undefined; }
}
