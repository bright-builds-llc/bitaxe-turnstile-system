/** Stable wire/profile identifier for the local Worker Controller contract. */
export const WORKER_CONTROLLER_PROTOCOL_VERSION = "bwg-worker-controller/0.1" as const;
/** Exclusive upper bound for one device Work Lease duration. */
export const MAXIMUM_WORK_LEASE_MILLISECONDS = 60_000;
/** Latest recommended renewal point within a still-valid Work Lease. */
export const MAXIMUM_RENEW_AFTER_MILLISECONDS = 20_000;

/** Strict non-secret board, firmware, protocol, and preservation discovery result. */
export type WorkerControllerCapabilities = {
  protocolVersion: typeof WORKER_CONTROLLER_PROTOCOL_VERSION;
  board: { model: string; revision: string; usbTransport: "web_serial" };
  firmware: { name: string; version: string };
  compatibility: {
    referenceFirmware: boolean;
    workLease: "supported";
    miningBaselineRestoration: "supported";
    settingsPreservation: "compatible" | "upgrade_required" | "unsupported";
  };
};

/** Authenticated, challenge-scoped configuration for starting one bounded device lease. */
export type WorkerLeaseGrant = {
  protocolVersion: typeof WORKER_CONTROLLER_PROTOCOL_VERSION;
  leaseId: string;
  challengeId: string;
  authorization: string;
  durationMilliseconds: number;
  renewAfterMilliseconds: number;
  stratum: { endpoint: string; username: string; password: string };
};

/** Authenticated extension for the exact active device lease. */
export type WorkerLeaseRenewal = {
  protocolVersion: typeof WORKER_CONTROLLER_PROTOCOL_VERSION;
  leaseId: string;
  authorization: string;
  durationMilliseconds: number;
  renewAfterMilliseconds: number;
};

/** Closed metadata-only reason that challenge mining returned to Mining Baseline. */
export type WorkerRestorationReason =
  | "paused"
  | "cancelled"
  | "lease_expired"
  | "lost_continuity"
  | "monotonic_reset"
  | "reboot"
  | "challenge_satisfied"
  | "challenge_expired"
  | "tab_closed"
  | "connectivity_lost"
  | "control_failed";

/** Every restoration reason accepted by runtime and USB boundary parsers. */
export const WORKER_RESTORATION_REASONS: readonly WorkerRestorationReason[] = [
  "paused",
  "cancelled",
  "lease_expired",
  "lost_continuity",
  "monotonic_reset",
  "reboot",
  "challenge_satisfied",
  "challenge_expired",
  "tab_closed",
  "connectivity_lost",
  "control_failed",
];

/** Redacted current device state; never includes credentials or captured baseline settings. */
export type WorkerControllerStatus =
  | {
      protocolVersion: typeof WORKER_CONTROLLER_PROTOCOL_VERSION;
      state: "mining";
      monotonicMilliseconds: number;
      lease: {
        leaseId: string;
        challengeId: string;
        renewAtMonotonicMilliseconds: number;
        expiresAtMonotonicMilliseconds: number;
      };
      restoration: { status: "pending"; reason?: never };
    }
  | {
      protocolVersion: typeof WORKER_CONTROLLER_PROTOCOL_VERSION;
      state: "baseline";
      monotonicMilliseconds: number;
      lease?: never;
      restoration:
        | { status: "not_required"; reason?: never }
        | { status: "confirmed"; reason: WorkerRestorationReason };
    };

/** Device-local transport-loss notification delivered after fail-safe restoration. */
export type WorkerControllerDisconnectReason = "connectivity_lost";

/** Version-parameterized controller method surface shared by every strict wire profile. */
export interface WorkerControllerContract<Capabilities, Grant, Renewal, Status> {
  /** Reads strict non-secret local compatibility metadata. */
  discover(): Promise<Capabilities>;
  /** Authenticates and starts one bounded challenge lease after capturing Mining Baseline. */
  startLease(grant: Grant): Promise<Status>;
  /** Authenticates and extends the exact active lease. */
  renewLease(renewal: Renewal): Promise<Status>;
  /** Reads redacted state and monotonic deadlines. */
  status(): Promise<Status>;
  /** Restores Mining Baseline with a paused confirmation. */
  pause(): Promise<Status>;
  /** Restores Mining Baseline with a cancelled confirmation. */
  cancel(): Promise<Status>;
  /** Restores Mining Baseline for an explicit closed reason. */
  restore(reason: WorkerRestorationReason): Promise<Status>;
  /** Observes device-local USB/control loss after the Worker has restored autonomously. */
  subscribeDisconnect?(
    listener: (reason: WorkerControllerDisconnectReason) => Promise<void>,
  ): () => void;
}

/** Controller 0.1 specialization used by existing headless clients, USB adapters, and firmware. */
export interface WorkerController
  extends WorkerControllerContract<
    WorkerControllerCapabilities,
    WorkerLeaseGrant,
    WorkerLeaseRenewal,
    WorkerControllerStatus
  > {}

/** Parses untrusted capability bytes into the strict non-secret domain shape. */
export function parseWorkerControllerCapabilities(input: unknown): WorkerControllerCapabilities {
  const value = exactRecord(input, ["protocolVersion", "board", "firmware", "compatibility"]);
  const board = exactRecord(value.board, ["model", "revision", "usbTransport"]);
  const firmware = exactRecord(value.firmware, ["name", "version"]);
  const compatibility = exactRecord(value.compatibility, [
    "referenceFirmware",
    "workLease",
    "miningBaselineRestoration",
    "settingsPreservation",
  ]);
  const settingsPreservation = requiredString(compatibility, "settingsPreservation");
  if (
    value.protocolVersion !== WORKER_CONTROLLER_PROTOCOL_VERSION ||
    !validLabel(requiredString(board, "model")) ||
    !validLabel(requiredString(board, "revision")) ||
    board.usbTransport !== "web_serial" ||
    !validLabel(requiredString(firmware, "name")) ||
    !validLabel(requiredString(firmware, "version")) ||
    typeof compatibility.referenceFirmware !== "boolean" ||
    compatibility.workLease !== "supported" ||
    compatibility.miningBaselineRestoration !== "supported" ||
    !["compatible", "upgrade_required", "unsupported"].includes(settingsPreservation)
  ) {
    throw new Error("Worker Controller capabilities are invalid");
  }
  return {
    protocolVersion: WORKER_CONTROLLER_PROTOCOL_VERSION,
    board: {
      model: requiredString(board, "model"),
      revision: requiredString(board, "revision"),
      usbTransport: "web_serial",
    },
    firmware: {
      name: requiredString(firmware, "name"),
      version: requiredString(firmware, "version"),
    },
    compatibility: {
      referenceFirmware: compatibility.referenceFirmware,
      workLease: "supported",
      miningBaselineRestoration: "supported",
      settingsPreservation: settingsPreservation as
        | "compatible"
        | "upgrade_required"
        | "unsupported",
    },
  };
}

/** Parses and bounds an untrusted full Work Lease grant without authenticating it. */
export function parseWorkerLeaseGrant(input: unknown): WorkerLeaseGrant {
  const value = exactRecord(input, [
    "protocolVersion",
    "leaseId",
    "challengeId",
    "authorization",
    "durationMilliseconds",
    "renewAfterMilliseconds",
    "stratum",
  ]);
  const stratum = exactRecord(value.stratum, ["endpoint", "username", "password"]);
  const window = parseLeaseWindow(value);
  const grant = {
    ...window,
    leaseId: requiredString(value, "leaseId"),
    challengeId: requiredString(value, "challengeId"),
    authorization: requiredString(value, "authorization"),
    stratum: {
      endpoint: requiredString(stratum, "endpoint"),
      username: requiredString(stratum, "username"),
      password: requiredString(stratum, "password"),
    },
  };
  if (
    !validIdentifier(grant.leaseId) ||
    !validIdentifier(grant.challengeId) ||
    !validSecret(grant.authorization) ||
    !validSecret(grant.stratum.username) ||
    !validSecret(grant.stratum.password) ||
    !validStratumEndpoint(grant.stratum.endpoint)
  ) {
    throw new Error("Work Lease grant is invalid");
  }
  return grant;
}

/** Parses and bounds an untrusted renewal without authenticating it. */
export function parseWorkerLeaseRenewal(input: unknown): WorkerLeaseRenewal {
  const value = exactRecord(input, [
    "protocolVersion",
    "leaseId",
    "authorization",
    "durationMilliseconds",
    "renewAfterMilliseconds",
  ]);
  const renewal = {
    ...parseLeaseWindow(value),
    leaseId: requiredString(value, "leaseId"),
    authorization: requiredString(value, "authorization"),
  };
  if (!validIdentifier(renewal.leaseId) || !validSecret(renewal.authorization)) {
    throw new Error("Work Lease renewal is invalid");
  }
  return renewal;
}

/** Parses untrusted device status and rejects unknown or secret-bearing extensions. */
export function parseWorkerControllerStatus(input: unknown): WorkerControllerStatus {
  const value = exactRecord(
    input,
    ["protocolVersion", "state", "monotonicMilliseconds", "restoration"],
    ["lease"],
  );
  const restoration = exactRecord(value.restoration, ["status"], ["reason"]);
  const monotonicMilliseconds = requiredNumber(value, "monotonicMilliseconds");
  const state = requiredString(value, "state");
  const maybeLease = value.lease === undefined ? undefined : parseStatusLease(value.lease);
  const status = requiredString(restoration, "status");
  const maybeReason = optionalString(restoration, "reason");
  if (
    value.protocolVersion !== WORKER_CONTROLLER_PROTOCOL_VERSION ||
    !safeNonNegative(monotonicMilliseconds) ||
    !["baseline", "mining"].includes(state) ||
    !["not_required", "pending", "confirmed"].includes(status) ||
    (maybeReason !== undefined && !WORKER_RESTORATION_REASONS.includes(
      maybeReason as WorkerRestorationReason,
    )) ||
    (status === "confirmed") !== (maybeReason !== undefined)
  ) {
    throw new Error("Worker Controller status is invalid");
  }
  if (
    maybeLease &&
    (maybeLease.expiresAtMonotonicMilliseconds <= monotonicMilliseconds ||
      maybeLease.expiresAtMonotonicMilliseconds <= maybeLease.renewAtMonotonicMilliseconds)
  ) {
    throw new Error("Worker Controller status is invalid");
  }
  if (state === "mining") {
    if (!maybeLease || status !== "pending" || maybeReason !== undefined) {
      throw new Error("Worker Controller status is invalid");
    }
    return {
      protocolVersion: WORKER_CONTROLLER_PROTOCOL_VERSION,
      state,
      monotonicMilliseconds,
      lease: maybeLease,
      restoration: { status },
    };
  }
  if (maybeLease || status === "pending") {
    throw new Error("Worker Controller status is invalid");
  }
  return {
    protocolVersion: WORKER_CONTROLLER_PROTOCOL_VERSION,
    state: "baseline",
    monotonicMilliseconds,
    restoration:
      status === "confirmed"
        ? { status, reason: parseWorkerRestorationReason(maybeReason) }
        : { status: "not_required" },
  };
}

/** Parses one restoration reason through the shared closed reason set. */
export function parseWorkerRestorationReason(input: unknown): WorkerRestorationReason {
  if (
    typeof input !== "string" ||
    !WORKER_RESTORATION_REASONS.includes(input as WorkerRestorationReason)
  ) {
    throw new Error("Worker restoration reason is invalid");
  }
  return input as WorkerRestorationReason;
}

function parseLeaseWindow(value: Record<string, unknown>) {
  if (value.protocolVersion !== WORKER_CONTROLLER_PROTOCOL_VERSION) {
    throw new Error("Worker Controller protocol version is unsupported");
  }
  const durationMilliseconds = requiredNumber(value, "durationMilliseconds");
  const renewAfterMilliseconds = requiredNumber(value, "renewAfterMilliseconds");
  if (
    !Number.isSafeInteger(durationMilliseconds) ||
    durationMilliseconds <= 0 ||
    durationMilliseconds > MAXIMUM_WORK_LEASE_MILLISECONDS
  ) {
    throw new Error("lease duration is outside the contract");
  }
  if (
    !Number.isSafeInteger(renewAfterMilliseconds) ||
    renewAfterMilliseconds <= 0 ||
    renewAfterMilliseconds > MAXIMUM_RENEW_AFTER_MILLISECONDS ||
    renewAfterMilliseconds >= durationMilliseconds
  ) {
    throw new Error("lease renewal deadline is outside the contract");
  }
  return {
    protocolVersion: WORKER_CONTROLLER_PROTOCOL_VERSION,
    durationMilliseconds,
    renewAfterMilliseconds,
  };
}

function parseStatusLease(input: unknown): NonNullable<WorkerControllerStatus["lease"]> {
  const value = exactRecord(input, [
    "leaseId",
    "challengeId",
    "renewAtMonotonicMilliseconds",
    "expiresAtMonotonicMilliseconds",
  ]);
  const lease = {
    leaseId: requiredString(value, "leaseId"),
    challengeId: requiredString(value, "challengeId"),
    renewAtMonotonicMilliseconds: requiredNumber(value, "renewAtMonotonicMilliseconds"),
    expiresAtMonotonicMilliseconds: requiredNumber(value, "expiresAtMonotonicMilliseconds"),
  };
  if (
    !validIdentifier(lease.leaseId) ||
    !validIdentifier(lease.challengeId) ||
    !safeNonNegative(lease.renewAtMonotonicMilliseconds) ||
    !safeNonNegative(lease.expiresAtMonotonicMilliseconds)
  ) {
    throw new Error("Worker Controller status is invalid");
  }
  return lease;
}

function exactRecord(
  input: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Worker Controller public shape is invalid");
  }
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value);
  const permitted = [...requiredKeys, ...optionalKeys];
  if (keys.some((key) => !permitted.includes(key))) {
    throw new Error("Worker Controller public shape contains an unknown field");
  }
  if (requiredKeys.some((key) => !keys.includes(key))) {
    throw new Error("Worker Controller public shape is incomplete");
  }
  return value;
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const result = value[key];
  if (typeof result !== "string") throw new Error("Worker Controller field is invalid");
  return result;
}

function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  const result = value[key];
  if (result !== undefined && typeof result !== "string") {
    throw new Error("Worker Controller field is invalid");
  }
  return result;
}

function requiredNumber(value: Record<string, unknown>, key: string): number {
  const result = value[key];
  if (typeof result !== "number") throw new Error("Worker Controller field is invalid");
  return result;
}

function safeNonNegative(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validIdentifier(value: string): boolean {
  return value.length > 0 && value.length <= 128 && /^[A-Za-z0-9_-]+$/u.test(value);
}

function validSecret(value: string): boolean {
  return value.length > 0 && value.length <= 512;
}

function validLabel(value: string): boolean {
  return value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._-]+$/u.test(value);
}

function validStratumEndpoint(value: string): boolean {
  try {
    const endpoint = new URL(value);
    return (
      endpoint.protocol === "stratum+tcp:" &&
      endpoint.hostname.length > 0 &&
      endpoint.username.length === 0 &&
      endpoint.password.length === 0 &&
      Number.isSafeInteger(Number(endpoint.port)) &&
      Number(endpoint.port) > 0 &&
      Number(endpoint.port) <= 65_535 &&
      endpoint.pathname === "/" &&
      endpoint.search.length === 0 &&
      endpoint.hash.length === 0
    );
  } catch {
    return false;
  }
}
