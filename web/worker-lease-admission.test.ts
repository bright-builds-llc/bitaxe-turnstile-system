import { expect, test } from "bun:test";

import {
  commitWorkerLeaseAdmission,
  invalidateWorkerLeaseAdmissionContext,
  planWorkerLeaseAdmission,
  WorkerLeaseAdmissionError,
  type WorkerLeaseAdmissionErrorCode,
  type WorkerLeaseAdmissionState,
} from "./worker-lease-admission";

const binding = "S".repeat(43);
const baseState: WorkerLeaseAdmissionState = {
  maybeContext: {
    controlSessionBindingSha256: binding,
    establishedAtMonotonicMilliseconds: 1_000,
  },
  highWaterByKeyId: { lease_key: "3" },
};

test("accepts a fresh Start and persists its high-water mark before effects", async () => {
  // Arrange
  const plan = planWorkerLeaseAdmission(baseState, {
    operation: "start",
    leaseId: "lease_fixture_03",
    controlSessionBindingSha256: binding,
    nowMonotonicMilliseconds: 2_000,
    authorization: { keyId: "lease_key", sequence: 4n },
  });
  const events: string[] = [];

  // Act
  await commitWorkerLeaseAdmission(
    plan,
    async () => {
      events.push("persist");
      return "committed";
    },
    async () => { events.push("effect"); },
  );

  // Assert
  expect(events).toEqual(["persist", "effect"]);
  expect(plan.nextState.highWaterByKeyId.lease_key).toBe("4");
  expect(plan.nextState.maybeContext?.maybeActiveLeaseId).toBe("lease_fixture_03");
});

test("does not begin a lease effect when high-water persistence fails", async () => {
  // Arrange
  const plan = planWorkerLeaseAdmission(baseState, {
    operation: "start",
    leaseId: "lease_fixture_03",
    controlSessionBindingSha256: binding,
    nowMonotonicMilliseconds: 2_000,
    authorization: { keyId: "lease_key", sequence: 4n },
  });
  let effectCalled = false;

  // Act
  const result = commitWorkerLeaseAdmission(
    plan,
    async () => { throw new Error("durable write failed"); },
    async () => { effectCalled = true; },
  );

  // Assert
  await expect(result).rejects.toThrow("durable write failed");
  expect(effectCalled).toBeFalse();
});

test("keeps the accepted high-water transition when the later lease effect fails", async () => {
  // Arrange
  const plan = planWorkerLeaseAdmission(baseState, {
    operation: "start",
    leaseId: "lease_fixture_03",
    controlSessionBindingSha256: binding,
    nowMonotonicMilliseconds: 2_000,
    authorization: { keyId: "lease_key", sequence: 4n },
  });
  let maybePersistedState: WorkerLeaseAdmissionState | undefined;

  // Act
  const result = commitWorkerLeaseAdmission(
    plan,
    async (transition) => {
      maybePersistedState = transition.nextState;
      return "committed";
    },
    async () => { throw new Error("effect interrupted"); },
  );

  // Assert
  await expect(result).rejects.toThrow("effect interrupted");
  expect(maybePersistedState?.highWaterByKeyId.lease_key).toBe("4");
  expect(() => planWorkerLeaseAdmission(maybePersistedState ?? baseState, {
    operation: "renew",
    leaseId: "lease_fixture_03",
    controlSessionBindingSha256: binding,
    nowMonotonicMilliseconds: 3_000,
    authorization: { keyId: "lease_key", sequence: 4n },
  })).toThrow("replay");
});

test("rejects replay, expired unused context, changed context, and post-restore use", () => {
  // Arrange
  const input = {
    operation: "start" as const,
    leaseId: "lease_fixture_03",
    controlSessionBindingSha256: binding,
    nowMonotonicMilliseconds: 2_000,
    authorization: { keyId: "lease_key", sequence: 4n },
  };
  const cases: Array<{
    expected: WorkerLeaseAdmissionErrorCode;
    state: WorkerLeaseAdmissionState;
    input: typeof input;
  }> = [
    {
      expected: "replay",
      state: baseState,
      input: { ...input, authorization: { keyId: "lease_key", sequence: 3n } },
    },
    {
      expected: "context_expired",
      state: baseState,
      input: { ...input, nowMonotonicMilliseconds: 61_000 },
    },
    {
      expected: "context_invalid",
      state: baseState,
      input: { ...input, controlSessionBindingSha256: "T".repeat(43) },
    },
    {
      expected: "context_invalid",
      state: invalidateWorkerLeaseAdmissionContext(baseState),
      input,
    },
  ];

  // Act / Assert
  for (const fixture of cases) {
    try {
      planWorkerLeaseAdmission(fixture.state, fixture.input);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkerLeaseAdmissionError);
      expect((error as WorkerLeaseAdmissionError).code).toBe(fixture.expected);
    }
  }
});

test("rejects corrupt replay state and monotonic clock regression", () => {
  // Arrange
  const input = {
    operation: "start" as const,
    leaseId: "lease_fixture_03",
    controlSessionBindingSha256: binding,
    nowMonotonicMilliseconds: 2_000,
    authorization: { keyId: "lease_key", sequence: 4n },
  };
  const corrupt = {
    ...baseState,
    highWaterByKeyId: { lease_key: "-1" },
  } as WorkerLeaseAdmissionState;
  const regressed = {
    ...input,
    nowMonotonicMilliseconds: 999,
  };

  // Act / Assert
  try {
    planWorkerLeaseAdmission(corrupt, input);
    throw new Error("expected corrupt state rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(WorkerLeaseAdmissionError);
    expect((error as WorkerLeaseAdmissionError).code).toBe("state_invalid");
  }
  try {
    planWorkerLeaseAdmission(baseState, regressed);
    throw new Error("expected monotonic reset rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(WorkerLeaseAdmissionError);
    expect((error as WorkerLeaseAdmissionError).code).toBe("monotonic_invalid");
  }
});

test("accepts the last millisecond of the unused context window", () => {
  // Arrange
  const input = {
    operation: "start" as const,
    leaseId: "lease_fixture_03",
    controlSessionBindingSha256: binding,
    nowMonotonicMilliseconds: 60_999,
    authorization: { keyId: "lease_key", sequence: 4n },
  };

  // Act
  const plan = planWorkerLeaseAdmission(baseState, input);

  // Assert
  expect(plan.acceptedSequence).toBe("4");
});

test("retains high-water replay rejection across a new possession context", () => {
  // Arrange
  const newBinding = "U".repeat(43);
  const nextContextState: WorkerLeaseAdmissionState = {
    highWaterByKeyId: { lease_key: "3" },
    maybeContext: {
      controlSessionBindingSha256: newBinding,
      establishedAtMonotonicMilliseconds: 2_000,
    },
  };

  // Act
  const replay = () => planWorkerLeaseAdmission(nextContextState, {
    operation: "start",
    leaseId: "lease_fixture_04",
    controlSessionBindingSha256: newBinding,
    nowMonotonicMilliseconds: 3_000,
    authorization: { keyId: "lease_key", sequence: 3n },
  });

  // Assert
  expect(replay).toThrow("replay");
});

test("rejects a boxed operation before it can bypass Start policy", () => {
  // Arrange
  const boxedOperation = new String("start") as unknown as "start";

  // Act
  const plan = () => planWorkerLeaseAdmission(baseState, {
    operation: boxedOperation,
    leaseId: "lease_fixture_03",
    controlSessionBindingSha256: binding,
    nowMonotonicMilliseconds: 2_000,
    authorization: { keyId: "lease_key", sequence: 4n },
  });

  // Assert
  expect(plan).toThrow("context_invalid");
});

test("retains replay state for a grammar-valid reserved property key ID", () => {
  // Arrange
  const state: WorkerLeaseAdmissionState = {
    highWaterByKeyId: Object.fromEntries([["__proto__", "3"]]),
    maybeContext: {
      controlSessionBindingSha256: binding,
      establishedAtMonotonicMilliseconds: 1_000,
    },
  };
  const input = {
    operation: "start" as const,
    leaseId: "lease_fixture_03",
    controlSessionBindingSha256: binding,
    nowMonotonicMilliseconds: 2_000,
    authorization: { keyId: "__proto__", sequence: 4n },
  };

  // Act
  const plan = planWorkerLeaseAdmission(state, input);

  // Assert
  expect(Object.hasOwn(plan.nextState.highWaterByKeyId, "__proto__")).toBeTrue();
  expect(plan.nextState.highWaterByKeyId.__proto__).toBe("4");
  expect(() => planWorkerLeaseAdmission(
    { ...state, highWaterByKeyId: plan.nextState.highWaterByKeyId },
    input,
  )).toThrow("replay");
});

test("atomic persistence rejects reverse-order and repeated admission plans", async () => {
  // Arrange
  let durableState = baseState;
  const effects: string[] = [];
  const planFour = planWorkerLeaseAdmission(baseState, {
    operation: "start",
    leaseId: "lease_fixture_03",
    controlSessionBindingSha256: binding,
    nowMonotonicMilliseconds: 2_000,
    authorization: { keyId: "lease_key", sequence: 4n },
  });
  const planFive = planWorkerLeaseAdmission(baseState, {
    operation: "start",
    leaseId: "lease_fixture_03",
    controlSessionBindingSha256: binding,
    nowMonotonicMilliseconds: 2_000,
    authorization: { keyId: "lease_key", sequence: 5n },
  });
  const compareAndSwap = async (
    plan: typeof planFour,
  ): Promise<"committed" | "stale" | "already_committed"> => {
    const current = durableState.highWaterByKeyId[plan.acceptedKeyId] ?? "0";
    if (current === plan.acceptedSequence) return "already_committed";
    if (
      current !== plan.expectedPriorSequence ||
      durableState.maybeContext?.controlSessionBindingSha256 !==
        plan.expectedControlSessionBindingSha256 ||
      durableState.maybeContext?.establishedAtMonotonicMilliseconds !==
        plan.expectedContextEstablishedAtMonotonicMilliseconds ||
      durableState.maybeContext?.maybeActiveLeaseId !==
        plan.maybeExpectedActiveLeaseId
    ) {
      return "stale";
    }
    durableState = plan.nextState;
    return "committed";
  };

  // Act
  await commitWorkerLeaseAdmission(
    planFive,
    compareAndSwap,
    async () => { effects.push("five"); },
  );
  const stale = commitWorkerLeaseAdmission(
    planFour,
    compareAndSwap,
    async () => { effects.push("four"); },
  );
  await expect(stale).rejects.toThrow("replay");
  const repeated = commitWorkerLeaseAdmission(
    planFive,
    compareAndSwap,
    async () => { effects.push("five-again"); },
  );

  // Assert
  await expect(repeated).rejects.toThrow("replay");
  expect(durableState.highWaterByKeyId.lease_key).toBe("5");
  expect(effects).toEqual(["five"]);
});
