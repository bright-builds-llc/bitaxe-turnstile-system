import {
  MAXIMUM_WORKER_LEASE_AUTHORIZATION_SEQUENCE,
  type VerifiedWorkerLeaseAuthorization,
  type WorkerLeaseAuthorizationOperation,
} from "./worker-lease-authorization";

/** Maximum age of an unused possession context presented for Start. */
export const UNUSED_WORKER_LEASE_CONTEXT_MILLISECONDS = 60_000;

/** Firmware-neutral replay and possession-context state used by conformance tests. */
export type WorkerLeaseAdmissionState = {
  maybeContext?: {
    controlSessionBindingSha256: string;
    establishedAtMonotonicMilliseconds: number;
    maybeActiveLeaseId?: string;
  };
  highWaterByKeyId: Readonly<Record<string, string>>;
};

/** Inputs required to decide whether authorization may precede one lease effect. */
export type WorkerLeaseAdmissionInput = {
  operation: WorkerLeaseAuthorizationOperation;
  leaseId: string;
  controlSessionBindingSha256: string;
  nowMonotonicMilliseconds: number;
  authorization: VerifiedWorkerLeaseAuthorization;
};

/** Durable state transition which must commit before its associated lease effect. */
export type PlannedWorkerLeaseAdmission = {
  nextState: WorkerLeaseAdmissionState;
  acceptedKeyId: string;
  acceptedSequence: string;
  expectedPriorSequence: string;
  expectedControlSessionBindingSha256: string;
  expectedContextEstablishedAtMonotonicMilliseconds: number;
  maybeExpectedActiveLeaseId?: string;
};

/** Atomic durable compare-and-swap outcome returned before any lease effect. */
export type WorkerLeaseAdmissionPersistenceResult =
  | "committed"
  | "stale"
  | "already_committed";

/** Closed rejection categories shared by browser, firmware, and conformance fixtures. */
export type WorkerLeaseAdmissionErrorCode =
  | "context_expired"
  | "context_invalid"
  | "monotonic_invalid"
  | "replay"
  | "state_invalid";

/** Admission failure with a stable category and no credential-bearing detail. */
export class WorkerLeaseAdmissionError extends Error {
  constructor(readonly code: WorkerLeaseAdmissionErrorCode) {
    super(`Worker Lease admission rejected: ${code}`);
    this.name = "WorkerLeaseAdmissionError";
  }
}

/** Plans a fail-closed replay/context transition without performing any effect. */
export function planWorkerLeaseAdmission(
  state: WorkerLeaseAdmissionState,
  input: WorkerLeaseAdmissionInput,
): PlannedWorkerLeaseAdmission {
  const admittedState = parseAdmissionState(state);
  const admittedInput = parseAdmissionInput(input);
  const maybeContext = admittedState.maybeContext;
  if (
    !maybeContext ||
    maybeContext.controlSessionBindingSha256 !==
      admittedInput.controlSessionBindingSha256
  ) {
    throw new WorkerLeaseAdmissionError("context_invalid");
  }
  if (
    admittedInput.nowMonotonicMilliseconds <
    maybeContext.establishedAtMonotonicMilliseconds
  ) {
    throw new WorkerLeaseAdmissionError("monotonic_invalid");
  }
  if (
    admittedInput.operation === "start" &&
    admittedInput.nowMonotonicMilliseconds -
      maybeContext.establishedAtMonotonicMilliseconds >=
      UNUSED_WORKER_LEASE_CONTEXT_MILLISECONDS
  ) {
    throw new WorkerLeaseAdmissionError("context_expired");
  }
  if (
    (admittedInput.operation === "start" && maybeContext.maybeActiveLeaseId) ||
    (admittedInput.operation === "renew" &&
      maybeContext.maybeActiveLeaseId !== admittedInput.leaseId)
  ) {
    throw new WorkerLeaseAdmissionError("context_invalid");
  }
  const maybeCurrent = Object.hasOwn(
    admittedState.highWaterByKeyId,
    admittedInput.authorization.keyId,
  )
    ? admittedState.highWaterByKeyId[admittedInput.authorization.keyId]
    : "0";
  if (maybeCurrent === undefined) {
    throw new WorkerLeaseAdmissionError("state_invalid");
  }
  const current = BigInt(maybeCurrent);
  if (
    admittedInput.authorization.sequence <= current
  ) {
    throw new WorkerLeaseAdmissionError("replay");
  }
  return {
    acceptedKeyId: admittedInput.authorization.keyId,
    acceptedSequence: admittedInput.authorization.sequence.toString(),
    expectedPriorSequence: current.toString(),
    expectedControlSessionBindingSha256:
      maybeContext.controlSessionBindingSha256,
    expectedContextEstablishedAtMonotonicMilliseconds:
      maybeContext.establishedAtMonotonicMilliseconds,
    ...(maybeContext.maybeActiveLeaseId === undefined
      ? {}
      : { maybeExpectedActiveLeaseId: maybeContext.maybeActiveLeaseId }),
    nextState: {
      highWaterByKeyId: copyHighWater(
        admittedState.highWaterByKeyId,
        [
          admittedInput.authorization.keyId,
          admittedInput.authorization.sequence.toString(),
        ],
      ),
      maybeContext: {
        ...maybeContext,
        ...(admittedInput.operation === "start"
          ? { maybeActiveLeaseId: admittedInput.leaseId }
          : {}),
      },
    },
  };
}

function parseAdmissionState(
  input: WorkerLeaseAdmissionState,
): WorkerLeaseAdmissionState {
  if (!plainRecord(input)) throw new WorkerLeaseAdmissionError("state_invalid");
  const keys = Object.keys(input);
  if (
    !keys.includes("highWaterByKeyId") ||
    keys.some((key) => !["maybeContext", "highWaterByKeyId"].includes(key)) ||
    !plainRecord(input.highWaterByKeyId)
  ) {
    throw new WorkerLeaseAdmissionError("state_invalid");
  }
  const highWaterByKeyId = copyHighWater({});
  for (const [keyId, sequence] of Object.entries(input.highWaterByKeyId)) {
    if (!validKeyId(keyId) || !validPersistedSequence(sequence)) {
      throw new WorkerLeaseAdmissionError("state_invalid");
    }
    highWaterByKeyId[keyId] = sequence;
  }
  const maybeContext = input.maybeContext;
  if (maybeContext === undefined) return { highWaterByKeyId };
  if (!plainRecord(maybeContext)) {
    throw new WorkerLeaseAdmissionError("state_invalid");
  }
  const contextKeys = Object.keys(maybeContext);
  if (
    !contextKeys.includes("controlSessionBindingSha256") ||
    !contextKeys.includes("establishedAtMonotonicMilliseconds") ||
    contextKeys.some((key) => ![
      "controlSessionBindingSha256",
      "establishedAtMonotonicMilliseconds",
      "maybeActiveLeaseId",
    ].includes(key)) ||
    !digest(maybeContext.controlSessionBindingSha256) ||
    !validMonotonic(maybeContext.establishedAtMonotonicMilliseconds) ||
    (maybeContext.maybeActiveLeaseId !== undefined &&
      !validLeaseId(maybeContext.maybeActiveLeaseId))
  ) {
    throw new WorkerLeaseAdmissionError("state_invalid");
  }
  return {
    highWaterByKeyId,
    maybeContext: {
      controlSessionBindingSha256: maybeContext.controlSessionBindingSha256,
      establishedAtMonotonicMilliseconds:
        maybeContext.establishedAtMonotonicMilliseconds,
      ...(maybeContext.maybeActiveLeaseId === undefined
        ? {}
        : { maybeActiveLeaseId: maybeContext.maybeActiveLeaseId }),
    },
  };
}

function parseAdmissionInput(
  input: WorkerLeaseAdmissionInput,
): WorkerLeaseAdmissionInput {
  if (
    !plainRecord(input) ||
    Object.keys(input).length !== 5 ||
    (input.operation !== "start" && input.operation !== "renew") ||
    !validLeaseId(input.leaseId) ||
    !digest(input.controlSessionBindingSha256) ||
    !validMonotonic(input.nowMonotonicMilliseconds) ||
    !plainRecord(input.authorization) ||
    Object.keys(input.authorization).length !== 2 ||
    !validKeyId(input.authorization.keyId) ||
    typeof input.authorization.sequence !== "bigint" ||
    input.authorization.sequence < 1n ||
    input.authorization.sequence > MAXIMUM_WORKER_LEASE_AUTHORIZATION_SEQUENCE
  ) {
    throw new WorkerLeaseAdmissionError("context_invalid");
  }
  return {
    operation: input.operation,
    leaseId: input.leaseId,
    controlSessionBindingSha256: input.controlSessionBindingSha256,
    nowMonotonicMilliseconds: input.nowMonotonicMilliseconds,
    authorization: {
      keyId: input.authorization.keyId,
      sequence: input.authorization.sequence,
    },
  };
}

function plainRecord(input: unknown): input is Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(input) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function validPersistedSequence(input: unknown): input is string {
  if (
    typeof input !== "string" ||
    !/^(0|[1-9][0-9]{0,19})$/u.test(input)
  ) {
    return false;
  }
  return BigInt(input) <= MAXIMUM_WORKER_LEASE_AUTHORIZATION_SEQUENCE;
}

function validMonotonic(input: unknown): input is number {
  return Number.isSafeInteger(input) && Number(input) >= 0;
}

function validKeyId(input: unknown): input is string {
  return typeof input === "string" && /^[A-Za-z0-9_-]{1,32}$/u.test(input);
}

function validLeaseId(input: unknown): input is string {
  return typeof input === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(input);
}

function digest(input: unknown): input is string {
  return typeof input === "string" && /^[A-Za-z0-9_-]{43}$/u.test(input);
}

/** Atomically compares the plan's prior sequence/context and persists before effects. */
export async function commitWorkerLeaseAdmission(
  plan: PlannedWorkerLeaseAdmission,
  persist: (
    plan: PlannedWorkerLeaseAdmission,
  ) => Promise<WorkerLeaseAdmissionPersistenceResult>,
  effect: () => Promise<void>,
): Promise<void> {
  const result = await persist(plan);
  if (result !== "committed") {
    throw new WorkerLeaseAdmissionError("replay");
  }
  await effect();
}

/** Clears every possession context on restoration, disconnect, or reboot. */
export function invalidateWorkerLeaseAdmissionContext(
  state: WorkerLeaseAdmissionState,
): WorkerLeaseAdmissionState {
  const admittedState = parseAdmissionState(state);
  return { highWaterByKeyId: copyHighWater(admittedState.highWaterByKeyId) };
}

function copyHighWater(
  source: Readonly<Record<string, string>>,
  maybeEntry?: readonly [string, string],
): Record<string, string> {
  const result = Object.create(null) as Record<string, string>;
  for (const [keyId, sequence] of Object.entries(source)) {
    result[keyId] = sequence;
  }
  if (maybeEntry) result[maybeEntry[0]] = maybeEntry[1];
  return result;
}
