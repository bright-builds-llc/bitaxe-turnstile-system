import { sha256Base64UrlBytes } from "./crypto-bytes";

/** Challenge and exclusive retention bound for one locally retained Worker fingerprint. */
export type WorkerContinuityScope = {
  challengeId: string;
  retentionExpiryUnixSeconds: number;
};

/** Only record shape permitted in the private `bwg-worker` IndexedDB store. */
export type StoredWorkerContinuity = {
  challengeBindingSha256: string;
  deviceIdentityFingerprint: string;
  retentionExpiryUnixSeconds: number;
};

/** Internal durable storage seam with IndexedDB and deterministic repository-test adapters. */
export interface WorkerContinuityStore {
  get(challengeBindingSha256: string): Promise<unknown>;
  compareAndEstablish(
    record: StoredWorkerContinuity,
  ): Promise<"established" | "matched" | "conflict">;
  delete(challengeBindingSha256: string): Promise<void>;
  sweepExpired(nowUnixSeconds: number): Promise<void>;
}

/** Internal-only dependency injection key used by repository tests, not package exports. */
export const workerContinuityTestOptions = Symbol("workerContinuityTestOptions");

export type WorkerContinuityTestOptions = {
  store: WorkerContinuityStore;
  nowUnixSeconds: () => number;
};

/** Challenge-local continuity handle that never exposes the raw challenge or Device Identity key. */
export interface WorkerContinuityAccess {
  challengeBindingSha256(): Promise<string>;
  maybeExpectedFingerprint(): Promise<string | undefined>;
  establish(deviceIdentityFingerprint: string): Promise<void>;
  clear(): Promise<void>;
}

/** Creates challenge-scoped durable continuity using a separate private IndexedDB database. */
export function createWorkerContinuityAccess(
  input: WorkerContinuityScope,
  options: {
    store?: WorkerContinuityStore;
    nowUnixSeconds?: () => number;
  } = {},
): WorkerContinuityAccess {
  const scope = parseScope(structuredClone(input));
  const store = options.store ?? indexedDbWorkerContinuityStore();
  const nowUnixSeconds = options.nowUnixSeconds ?? (() => Math.floor(Date.now() / 1_000));
  const binding = sha256Base64UrlBytes(
    new TextEncoder().encode(`bwg-worker-continuity/0.1:${scope.challengeId}`),
  );
  return {
    challengeBindingSha256: () => binding,
    async maybeExpectedFingerprint() {
      const now = validNow(nowUnixSeconds());
      await store.sweepExpired(now);
      const challengeBindingSha256 = await binding;
      const maybeRecord = parseStoredRecord(await store.get(challengeBindingSha256));
      if (!maybeRecord) return undefined;
      if (maybeRecord.retentionExpiryUnixSeconds !== scope.retentionExpiryUnixSeconds) {
        throw new Error("Worker continuity retention binding is invalid");
      }
      return maybeRecord.deviceIdentityFingerprint;
    },
    async establish(deviceIdentityFingerprint) {
      if (!digest(deviceIdentityFingerprint)) {
        throw new Error("Worker Device Identity fingerprint is invalid");
      }
      const now = validNow(nowUnixSeconds());
      if (now >= scope.retentionExpiryUnixSeconds) {
        throw new Error("Worker continuity retention has expired");
      }
      const challengeBindingSha256 = await binding;
      await store.sweepExpired(now);
      const result = await store.compareAndEstablish({
        challengeBindingSha256,
        deviceIdentityFingerprint,
        retentionExpiryUnixSeconds: scope.retentionExpiryUnixSeconds,
      });
      if (result === "conflict") {
        throw new Error("Worker Device Identity continuity conflict");
      }
    },
    async clear() {
      await store.delete(await binding);
    },
  };
}

function parseScope(input: WorkerContinuityScope): WorkerContinuityScope {
  if (
    typeof input.challengeId !== "string" ||
    !/^challenge_[A-Za-z0-9_-]{1,118}$/u.test(input.challengeId) ||
    !Number.isSafeInteger(input.retentionExpiryUnixSeconds) ||
    input.retentionExpiryUnixSeconds <= 0
  ) {
    throw new Error("Worker continuity scope is invalid");
  }
  return input;
}

function parseStoredRecord(input: unknown): StoredWorkerContinuity | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Stored Worker continuity is invalid");
  }
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value);
  if (
    keys.length !== 3 ||
    !keys.includes("challengeBindingSha256") ||
    !keys.includes("deviceIdentityFingerprint") ||
    !keys.includes("retentionExpiryUnixSeconds") ||
    !digest(value.challengeBindingSha256) ||
    !digest(value.deviceIdentityFingerprint) ||
    typeof value.retentionExpiryUnixSeconds !== "number" ||
    !Number.isSafeInteger(value.retentionExpiryUnixSeconds) ||
    value.retentionExpiryUnixSeconds <= 0
  ) {
    throw new Error("Stored Worker continuity is invalid");
  }
  return {
    challengeBindingSha256: value.challengeBindingSha256,
    deviceIdentityFingerprint: value.deviceIdentityFingerprint,
    retentionExpiryUnixSeconds: value.retentionExpiryUnixSeconds,
  };
}

function validNow(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Worker continuity clock is invalid");
  }
  return value;
}

function digest(input: unknown): input is string {
  return typeof input === "string" && /^[A-Za-z0-9_-]{43}$/u.test(input);
}

function indexedDbWorkerContinuityStore(): WorkerContinuityStore {
  if (typeof indexedDB === "undefined") throw new Error("Worker continuity storage is unavailable");
  return {
    async get(challengeBindingSha256) {
      const database = await openDatabase();
      try {
        return await requestResult(
          database.transaction("continuity", "readonly")
            .objectStore("continuity")
            .get(challengeBindingSha256),
        );
      } finally {
        database.close();
      }
    },
    async compareAndEstablish(record) {
      const database = await openDatabase();
      try {
        return await compareAndEstablishRecord(database, record);
      } finally {
        database.close();
      }
    },
    async delete(challengeBindingSha256) {
      const database = await openDatabase();
      try {
        await transactionResult(
          database,
          "readwrite",
          (store) => store.delete(challengeBindingSha256),
        );
      } finally {
        database.close();
      }
    },
    async sweepExpired(nowUnixSeconds) {
      const database = await openDatabase();
      try {
        await sweepExpiredRecords(database, nowUnixSeconds);
      } finally {
        database.close();
      }
    },
  };
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("bwg-worker", 2);
    request.onupgradeneeded = () => {
      const database = request.result;
      const store = database.objectStoreNames.contains("continuity")
        ? request.transaction?.objectStore("continuity")
        : database.createObjectStore("continuity", {
          keyPath: "challengeBindingSha256",
        });
      if (store && !store.indexNames.contains("retentionExpiryUnixSeconds")) {
        store.createIndex("retentionExpiryUnixSeconds", "retentionExpiryUnixSeconds");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("Worker continuity storage failed"));
    request.onblocked = () => reject(new Error("Worker continuity storage is blocked"));
  });
}

function compareAndEstablishRecord(
  database: IDBDatabase,
  record: StoredWorkerContinuity,
): Promise<"established" | "matched" | "conflict"> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("continuity", "readwrite");
    const store = transaction.objectStore("continuity");
    const request = store.get(record.challengeBindingSha256);
    let result: "established" | "matched" | "conflict" = "conflict";
    request.onsuccess = () => {
      try {
        const maybeExisting = parseStoredRecord(request.result as unknown);
        if (!maybeExisting) {
          store.put(structuredClone(record));
          result = "established";
          return;
        }
        result =
          maybeExisting.deviceIdentityFingerprint === record.deviceIdentityFingerprint &&
          maybeExisting.retentionExpiryUnixSeconds === record.retentionExpiryUnixSeconds
            ? "matched"
            : "conflict";
      } catch {
        transaction.abort();
      }
    };
    request.onerror = () => reject(new Error("Worker continuity storage failed"));
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(new Error("Worker continuity storage failed"));
    transaction.onabort = () => reject(new Error("Worker continuity storage failed"));
  });
}

function sweepExpiredRecords(
  database: IDBDatabase,
  nowUnixSeconds: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("continuity", "readwrite");
    const index = transaction.objectStore("continuity").index("retentionExpiryUnixSeconds");
    const request = index.openKeyCursor(IDBKeyRange.upperBound(nowUnixSeconds));
    request.onsuccess = () => {
      const maybeCursor = request.result;
      if (!maybeCursor) return;
      transaction.objectStore("continuity").delete(maybeCursor.primaryKey);
      maybeCursor.continue();
    };
    request.onerror = () => reject(new Error("Worker continuity storage failed"));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(new Error("Worker continuity storage failed"));
    transaction.onabort = () => reject(new Error("Worker continuity storage failed"));
  });
}

function requestResult(request: IDBRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as unknown);
    request.onerror = () => reject(new Error("Worker continuity storage failed"));
  });
}

function transactionResult(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("continuity", mode);
    operation(transaction.objectStore("continuity"));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(new Error("Worker continuity storage failed"));
    transaction.onabort = () => reject(new Error("Worker continuity storage failed"));
  });
}

/** Qualification-only continuity lives in RAM and never opens IndexedDB. */
export function createMemoryWorkerContinuityAccess(scope: WorkerContinuityScope): WorkerContinuityAccess {
  const records = new Map<string, StoredWorkerContinuity>();
  return createWorkerContinuityAccess(scope, {store: {
    async get(binding) { return records.get(binding); },
    async compareAndEstablish(record) {
      const maybePrior = records.get(record.challengeBindingSha256);
      if (maybePrior) return maybePrior.deviceIdentityFingerprint === record.deviceIdentityFingerprint ? "matched" : "conflict";
      records.set(record.challengeBindingSha256, {...record}); return "established";
    },
    async delete(binding) { records.delete(binding); },
    async sweepExpired(now) { for (const [binding,record] of records) if(now >= record.retentionExpiryUnixSeconds) records.delete(binding); },
  }});
}
