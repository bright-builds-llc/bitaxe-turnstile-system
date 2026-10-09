import { encodeBase64Url } from "./crypto-bytes";
import { parseWorkerLeaseGrant, parseWorkerLeaseRenewal, type WorkerLeaseGrant, type WorkerLeaseRenewal } from "./worker-controller";
import type { WorkerPreservation } from "./worker-preservation";
import { exactSerialRecord, serialFailure, serialToken } from "./worker-serial";
import { isWorkerV2Stratum } from "./worker-v2-stratum";

/**
 * BWG-007 serial restoration qualification (firmware ADR-0035). Exact wire shapes for the bounded clock
 * stimulus and the metadata-only rejection review, plus the unbudgeted Conservative scenario leases.
 */
export const CLOCK_DISCONTINUITY_OFFSET_MILLISECONDS = 1000;
export const CLOCK_DISCONTINUITY_ARMED_MILLISECONDS = 2000;
export const WORKER_RESTORATION_SCENARIOS = ["completion", "pause", "cancel", "expiry", "monotonic_uncertainty", "disconnect", "reboot", "authorization_negatives"] as const;
export type WorkerRestorationScenario = typeof WORKER_RESTORATION_SCENARIOS[number];

export type ClockDiscontinuityStimulusAck = {
  schema: "worker-clock-discontinuity-stimulus-v1"; requestNonce: string;
  offsetMilliseconds: typeof CLOCK_DISCONTINUITY_OFFSET_MILLISECONDS; armedForMilliseconds: typeof CLOCK_DISCONTINUITY_ARMED_MILLISECONDS;
};
export type ClockDiscontinuityStimulusState = "idle" | "armed" | "consumed" | "expired";
export type ClockDiscontinuityStimulusReview = {
  schema: "worker-clock-discontinuity-stimulus-review-v1"; state: ClockDiscontinuityStimulusState;
  offsetMilliseconds: typeof CLOCK_DISCONTINUITY_OFFSET_MILLISECONDS; discontinuitiesDetected: number;
};
export type AuthorizationRejectionRecord = {
  ordinal: number; operation: "start" | "renew"; signature: "valid" | "invalid" | "not_evaluated";
  context: "current" | "mismatch" | "expired" | "absent"; replayGuard: "fresh" | "at_or_below_durable_high_water" | "unavailable" | "not_evaluated";
};
export type AuthorizationRejectionReview = {
  schema: "worker-authorization-rejection-review-v1"; bootRejections: number; last: AuthorizationRejectionRecord | null;
  highWater: { advancedThisBoot: boolean; fingerprintSha256: string };
};

function u32(value: unknown, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > 0xffffffff) throw serialFailure("fields");
  return value;
}
function closed<const T extends string>(value: unknown, allowed: readonly T[]): T {
  const maybe = allowed.find(candidate => candidate === value);
  if (maybe === undefined) throw serialFailure("fields");
  return maybe;
}

/** A fresh 16-byte nonce as canonical 22-character base64url, the same form as restart nonces. */
export function createClockDiscontinuityNonce(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

export function parseClockDiscontinuityStimulusAck(input: unknown, requestNonce: string): ClockDiscontinuityStimulusAck {
  const value = exactSerialRecord(input, ["schema", "requestNonce", "offsetMilliseconds", "armedForMilliseconds"]);
  if (!serialToken(requestNonce) || value.schema !== "worker-clock-discontinuity-stimulus-v1" || value.requestNonce !== requestNonce ||
    value.offsetMilliseconds !== CLOCK_DISCONTINUITY_OFFSET_MILLISECONDS || value.armedForMilliseconds !== CLOCK_DISCONTINUITY_ARMED_MILLISECONDS) throw serialFailure("fields");
  return { schema: "worker-clock-discontinuity-stimulus-v1", requestNonce, offsetMilliseconds: CLOCK_DISCONTINUITY_OFFSET_MILLISECONDS, armedForMilliseconds: CLOCK_DISCONTINUITY_ARMED_MILLISECONDS };
}

export function parseClockDiscontinuityStimulusReview(input: unknown): ClockDiscontinuityStimulusReview {
  const value = exactSerialRecord(input, ["schema", "state", "offsetMilliseconds", "discontinuitiesDetected"]);
  if (value.schema !== "worker-clock-discontinuity-stimulus-review-v1" || value.offsetMilliseconds !== CLOCK_DISCONTINUITY_OFFSET_MILLISECONDS) throw serialFailure("fields");
  return { schema: "worker-clock-discontinuity-stimulus-review-v1", state: closed(value.state, ["idle", "armed", "consumed", "expired"] as const),
    offsetMilliseconds: CLOCK_DISCONTINUITY_OFFSET_MILLISECONDS, discontinuitiesDetected: u32(value.discontinuitiesDetected) };
}

function parseRejectionRecord(input: unknown, bootRejections: number): AuthorizationRejectionRecord {
  const value = exactSerialRecord(input, ["ordinal", "operation", "signature", "context", "replayGuard"]);
  const ordinal = u32(value.ordinal, 1);
  if (ordinal > bootRejections) throw serialFailure("fields");
  return { ordinal, operation: closed(value.operation, ["start", "renew"] as const), signature: closed(value.signature, ["valid", "invalid", "not_evaluated"] as const),
    context: closed(value.context, ["current", "mismatch", "expired", "absent"] as const),
    replayGuard: closed(value.replayGuard, ["fresh", "at_or_below_durable_high_water", "unavailable", "not_evaluated"] as const) };
}

export function parseAuthorizationRejectionReview(input: unknown): AuthorizationRejectionReview {
  const value = exactSerialRecord(input, ["schema", "bootRejections", "last", "highWater"]);
  if (value.schema !== "worker-authorization-rejection-review-v1") throw serialFailure("fields");
  const bootRejections = u32(value.bootRejections);
  if ((bootRejections === 0) !== (value.last === null)) throw serialFailure("fields");
  const highWater = exactSerialRecord(value.highWater, ["advancedThisBoot", "fingerprintSha256"]);
  if (typeof highWater.advancedThisBoot !== "boolean" || typeof highWater.fingerprintSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(highWater.fingerprintSha256)) throw serialFailure("fields");
  return { schema: "worker-authorization-rejection-review-v1", bootRejections, last: value.last === null ? null : parseRejectionRecord(value.last, bootRejections),
    highWater: { advancedThisBoot: highWater.advancedThisBoot, fingerprintSha256: highWater.fingerprintSha256 } };
}

/** Restoration lease windows (decision D1); only the 60,000/20,000 ms window may carry its one renewal. */
function maximumRenewals(value: { durationMilliseconds: number; renewAfterMilliseconds: number }): number | undefined {
  if (value.durationMilliseconds === 60000 && value.renewAfterMilliseconds === 20000) return 1;
  if (value.durationMilliseconds === 30000 && value.renewAfterMilliseconds === 10000) return 0;
  return undefined;
}

/** An unbudgeted Conservative Stratum V1 Start: no campaign, attempt, soak allowance or upstream-default profile. */
export function parseRestorationGrant(input: unknown): WorkerLeaseGrant {
  const grant = parseWorkerLeaseGrant(input);
  if (grant.acceptanceCampaign || grant.qualificationAttempt || grant.soakAllowance) throw new Error("restoration_grant_budgeted");
  if (isWorkerV2Stratum(grant.stratum) || (grant.hardwareProfile ?? "conservative") !== "conservative") throw new Error("restoration_grant_profile");
  if (maximumRenewals(grant) === undefined) throw new Error("restoration_window");
  return grant;
}

export function parseRestorationRenewal(input: unknown): WorkerLeaseRenewal {
  const renewal = parseWorkerLeaseRenewal(input);
  if (maximumRenewals(renewal) !== 1) throw new Error("restoration_renewal_window");
  return renewal;
}

export type RestorationWindow = { grant: WorkerLeaseGrant; renewals: WorkerLeaseRenewal[] };
export function parseRestorationWindow(input: unknown): RestorationWindow {
  const value = exactSerialRecord(input, ["grant", "renewals"]);
  const grant = parseRestorationGrant(value.grant);
  if (!Array.isArray(value.renewals) || value.renewals.length > (maximumRenewals(grant) ?? 0)) throw new Error("restoration_renewal_bound");
  const renewals = value.renewals.map(parseRestorationRenewal);
  if (renewals.some(renewal => renewal.leaseId !== grant.leaseId)) throw new Error("renewal_lease_mismatch");
  return { grant, renewals };
}

/** A previously signed artifact the host replays unchanged; the device, not the Gate, must reject it. */
export type RestorationReplayArtifact = { operation: "start"; grant: WorkerLeaseGrant } | { operation: "renew"; renewal: WorkerLeaseRenewal };
export function parseRestorationReplayArtifact(input: unknown): RestorationReplayArtifact {
  const operation = input && typeof input === "object" && "operation" in input ? input.operation : undefined;
  if (operation === "start") return { operation, grant: parseRestorationGrant(exactSerialRecord(input, ["operation", "grant"]).grant) };
  if (operation === "renew") return { operation, renewal: parseRestorationRenewal(exactSerialRecord(input, ["operation", "renewal"]).renewal) };
  throw new Error("replay_artifact_invalid");
}

/**
 * Page-local authorization high-water continuity. Raw digests never leave this object: callers see a change
 * epoch and which epoch first observed a fingerprint, so a judge can compare across reconnects and reboots.
 */
export class WorkerRestorationHighWater {
  readonly #firstEpoch = new Map<string, number>();
  #maybeLatest: string | undefined;
  #epoch = 0;
  observe(value: Pick<WorkerPreservation, "authorization_high_water_sha256">): void {
    const digest = value.authorization_high_water_sha256;
    if (digest === this.#maybeLatest) return;
    this.#epoch += 1;
    this.#maybeLatest = digest;
    if (!this.#firstEpoch.has(digest) && this.#firstEpoch.size < 64) this.#firstEpoch.set(digest, this.#epoch);
  }
  get epoch(): number { return this.#epoch; }
  compare(fingerprintSha256: string): { fingerprintMatchesLatestObservation: boolean; fingerprintFirstObservedEpoch: number | null } {
    return { fingerprintMatchesLatestObservation: fingerprintSha256 === this.#maybeLatest, fingerprintFirstObservedEpoch: this.#firstEpoch.get(fingerprintSha256) ?? null };
  }
}

/** Same-key reacquisition: how many distinct device identity digests this page has seen (expected 1). */
export class WorkerRestorationDeviceIdentity {
  readonly #seen = new Set<string>();
  #overflow = 0;
  #observations = 0;
  /** Returns true when this observation introduced a new identity after the first. */
  observe(value: Pick<WorkerPreservation, "device_identity_sha256">): boolean {
    this.#observations += 1;
    const digest = value.device_identity_sha256;
    if (this.#seen.has(digest)) return false;
    if (this.#seen.size < 64) this.#seen.add(digest); else this.#overflow += 1;
    return this.epoch > 1;
  }
  get epoch(): number { return this.#seen.size + this.#overflow; }
  publicState(): { epoch: number; observations: number } | null {
    return this.#observations === 0 ? null : { epoch: this.epoch, observations: this.#observations };
  }
}

/** Counts `worker-preservation-v2` observations; one `false` makes `changed` true for the page lifetime. */
export class WorkerRestorationPoolConfiguration {
  #observations = 0;
  #changed = false;
  /** Returns true only on the observation that first reports a changed pool configuration. */
  observe(value: WorkerPreservation): boolean {
    if (value.schema !== "worker-preservation-v2") return false;
    this.#observations += 1;
    if (value.pool_configuration_unchanged_since_boot || this.#changed) return false;
    this.#changed = true;
    return true;
  }
  publicState(): { observations: number; changed: boolean } | null {
    return this.#observations === 0 ? null : { observations: this.#observations, changed: this.#changed };
  }
}
