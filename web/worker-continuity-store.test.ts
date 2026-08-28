import { describe, expect, test } from "bun:test";

import {
  createWorkerContinuityAccess,
  type WorkerContinuityStore,
} from "./worker-continuity-store";

describe("challenge-scoped Worker continuity", () => {
  test("restores only the fingerprint retained for the same current challenge", async () => {
    // Arrange
    const store = memoryStore();
    const initial = createWorkerContinuityAccess(
      {
        challengeId: "challenge_00000000000000000000000000000001",
        retentionExpiryUnixSeconds: 2_000,
      },
      { store, nowUnixSeconds: () => 1_000 },
    );
    await initial.establish("F".repeat(43));
    const restored = createWorkerContinuityAccess(
      {
        challengeId: "challenge_00000000000000000000000000000001",
        retentionExpiryUnixSeconds: 2_000,
      },
      { store, nowUnixSeconds: () => 1_001 },
    );

    // Act
    const fingerprint = await restored.maybeExpectedFingerprint();

    // Assert
    expect(fingerprint).toBe("F".repeat(43));
    expect(JSON.stringify(store.snapshot())).not.toMatch(
      /challenge_000|jwk|serial|credential|password/i,
    );
  });

  test("deletes an expired continuity fingerprint instead of restoring it", async () => {
    // Arrange
    const store = memoryStore();
    const initial = createWorkerContinuityAccess(
      {
        challengeId: "challenge_00000000000000000000000000000001",
        retentionExpiryUnixSeconds: 1_100,
      },
      { store, nowUnixSeconds: () => 1_000 },
    );
    await initial.establish("F".repeat(43));
    const expired = createWorkerContinuityAccess(
      {
        challengeId: "challenge_00000000000000000000000000000001",
        retentionExpiryUnixSeconds: 1_100,
      },
      { store, nowUnixSeconds: () => 1_100 },
    );

    // Act
    const fingerprint = await expired.maybeExpectedFingerprint();

    // Assert
    expect(fingerprint).toBeUndefined();
    expect(store.snapshot()).toEqual([]);
  });

  test("preserves a live fingerprint when another scope supplies a different expiry", async () => {
    // Arrange
    const store = memoryStore();
    const original = createWorkerContinuityAccess(
      {
        challengeId: "challenge_00000000000000000000000000000001",
        retentionExpiryUnixSeconds: 2_000,
      },
      { store, nowUnixSeconds: () => 1_000 },
    );
    await original.establish("F".repeat(43));
    const mismatched = createWorkerContinuityAccess(
      {
        challengeId: "challenge_00000000000000000000000000000001",
        retentionExpiryUnixSeconds: 3_000,
      },
      { store, nowUnixSeconds: () => 1_001 },
    );

    // Act
    const mismatchedLookup = mismatched.maybeExpectedFingerprint();

    // Assert
    await expect(mismatchedLookup).rejects.toThrow("retention binding is invalid");
    await expect(original.maybeExpectedFingerprint()).resolves.toBe("F".repeat(43));
  });

  test("atomically rejects a different first Worker for the same challenge", async () => {
    // Arrange
    const store = memoryStore();
    const scope = {
      challengeId: "challenge_00000000000000000000000000000001",
      retentionExpiryUnixSeconds: 2_000,
    };
    const first = createWorkerContinuityAccess(scope, {
      store,
      nowUnixSeconds: () => 1_000,
    });
    const second = createWorkerContinuityAccess(scope, {
      store,
      nowUnixSeconds: () => 1_000,
    });

    // Act
    const results = await Promise.allSettled([
      first.establish("F".repeat(43)),
      second.establish("G".repeat(43)),
    ]);

    // Assert
    expect(results.map((result) => result.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
  });

  test("sweeps expired records even when their original challenge is never reopened", async () => {
    // Arrange
    const store = memoryStore();
    const abandoned = createWorkerContinuityAccess(
      {
        challengeId: "challenge_00000000000000000000000000000001",
        retentionExpiryUnixSeconds: 1_100,
      },
      { store, nowUnixSeconds: () => 1_000 },
    );
    await abandoned.establish("F".repeat(43));
    const anotherChallenge = createWorkerContinuityAccess(
      {
        challengeId: "challenge_00000000000000000000000000000002",
        retentionExpiryUnixSeconds: 2_000,
      },
      { store, nowUnixSeconds: () => 1_100 },
    );

    // Act
    await anotherChallenge.maybeExpectedFingerprint();

    // Assert
    expect(store.snapshot()).toEqual([]);
  });
});

function memoryStore(): WorkerContinuityStore & { snapshot(): unknown[] } {
  const records = new Map<string, unknown>();
  return {
    async get(challengeBindingSha256) {
      return structuredClone(records.get(challengeBindingSha256));
    },
    async compareAndEstablish(record) {
      const maybeExisting = records.get(record.challengeBindingSha256) as
        | typeof record
        | undefined;
      if (!maybeExisting) {
        records.set(record.challengeBindingSha256, structuredClone(record));
        return "established";
      }
      return maybeExisting.deviceIdentityFingerprint === record.deviceIdentityFingerprint &&
        maybeExisting.retentionExpiryUnixSeconds === record.retentionExpiryUnixSeconds
        ? "matched"
        : "conflict";
    },
    async delete(challengeBindingSha256) {
      records.delete(challengeBindingSha256);
    },
    async sweepExpired(nowUnixSeconds) {
      for (const [key, value] of records) {
        const record = value as { retentionExpiryUnixSeconds: number };
        if (record.retentionExpiryUnixSeconds <= nowUnixSeconds) records.delete(key);
      }
    },
    snapshot() {
      return structuredClone([...records.values()]);
    },
  };
}
