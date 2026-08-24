import { canonicalJson, positiveInteger } from "./headless-values";
import type { WorkConsentReceipt } from "./headless-client.types";

type StoredClaimantKey = {
  keyId: string;
  publicJwk: JsonWebKey;
  privateKey: CryptoKey;
  retentionExpiry: number;
  maybeBoundChallengeId?: string;
  maybeConsentBinding?: {
    challengeId: string;
    receipt: WorkConsentReceipt;
  };
};

type ClaimantKeyStore = {
  get(keyId: string): Promise<unknown>;
  put(record: StoredClaimantKey): Promise<void>;
  bindConsent(
    keyId: string,
    challengeId: string,
    receipt: WorkConsentReceipt,
  ): Promise<StoredClaimantKey>;
  delete(keyId: string): Promise<void>;
};

type ClaimantIdentityOptions = {
  maybeClock?: () => number;
  maybeIssuanceWindowSeconds?: number;
};

const DEFAULT_ISSUANCE_WINDOW_SECONDS = 300;

export const claimantIdentityAccess = Symbol("claimantIdentityAccess");
const claimantIdentityConstruction = Symbol("claimantIdentityConstruction");

export class PreparedClaimantIdentity {
  readonly #record: StoredClaimantKey;
  readonly #store: ClaimantKeyStore;
  readonly #now: () => number;

  private constructor(
    record: StoredClaimantKey,
    store: ClaimantKeyStore,
    now: () => number,
  ) {
    this.#record = record;
    this.#store = store;
    this.#now = now;
  }

  keyId(): string {
    return this.#record.keyId;
  }

  claimantKey(): string {
    return claimantKeyJson(this.#record.publicJwk);
  }

  claimantPublicJwk(): JsonWebKey {
    return structuredClone(this.#record.publicJwk);
  }

  static [claimantIdentityConstruction](
    record: StoredClaimantKey,
    store: ClaimantKeyStore,
    now: () => number,
  ): PreparedClaimantIdentity {
    return new PreparedClaimantIdentity(record, store, now);
  }

  [claimantIdentityAccess](): {
    bindToChallenge(challengeId: string, expiresAtUnixSeconds: number): Promise<void>;
    retainThrough(expiresAtUnixSeconds: number): Promise<void>;
    recordConsent(challengeId: string, receipt: WorkConsentReceipt): Promise<void>;
    maybeConsentFor(challengeId: string): WorkConsentReceipt | undefined;
    sign(payload: Uint8Array): Promise<ArrayBuffer>;
  } {
    return {
      bindToChallenge: async (challengeId, expiresAtUnixSeconds) => {
        await this.#requireRetained();
        if (
          this.#record.maybeBoundChallengeId !== undefined &&
          this.#record.maybeBoundChallengeId !== challengeId
        ) {
          throw new Error("Claimant key is already bound to another Work Challenge");
        }
        if (this.#record.maybeBoundChallengeId === challengeId) return;
        const retentionExpiry = positiveInteger(
          expiresAtUnixSeconds,
          "retention expiry",
        );
        const nowUnixSeconds = this.#now();
        if (!Number.isSafeInteger(nowUnixSeconds) || nowUnixSeconds >= retentionExpiry) {
          await this.#store.delete(this.#record.keyId);
          throw new Error("Work Challenge already exceeds Claimant key retention");
        }
        this.#record.maybeBoundChallengeId = challengeId;
        this.#record.retentionExpiry = retentionExpiry;
        await this.#store.put(this.#record);
      },
      retainThrough: async (expiresAtUnixSeconds) => {
        await this.#requireRetained();
        if (!this.#record.maybeBoundChallengeId) {
          throw new Error("Claimant key is not bound to a Work Challenge");
        }
        this.#record.retentionExpiry = Math.max(
          this.#record.retentionExpiry,
          positiveInteger(expiresAtUnixSeconds, "retention expiry"),
        );
        await this.#store.put(this.#record);
      },
      recordConsent: async (challengeId, receipt) => {
        await this.#requireRetained();
        const updated = await this.#store.bindConsent(
          this.#record.keyId,
          challengeId,
          receipt,
        );
        const consentBinding = updated.maybeConsentBinding;
        if (!consentBinding) throw new Error("Work Consent storage lost its binding");
        this.#record.maybeConsentBinding = consentBinding;
      },
      maybeConsentFor: (challengeId) => {
        if (this.#record.maybeConsentBinding?.challengeId !== challengeId) return undefined;
        return structuredClone(this.#record.maybeConsentBinding.receipt);
      },
      sign: async (payload) => {
        await this.#requireRetained();
        return crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          this.#record.privateKey,
          Uint8Array.from(payload).buffer,
        );
      },
    };
  }

  async #requireRetained(): Promise<void> {
    const nowUnixSeconds = this.#now();
    if (
      !Number.isSafeInteger(nowUnixSeconds) ||
      nowUnixSeconds >= this.#record.retentionExpiry
    ) {
      await this.#store.delete(this.#record.keyId);
      throw new Error("Claimant key is no longer retained");
    }
  }
}

export async function prepareClaimantIdentity(
  options: ClaimantIdentityOptions = {},
): Promise<PreparedClaimantIdentity> {
  const now = clock(options);
  const nowUnixSeconds = now();
  if (!Number.isSafeInteger(nowUnixSeconds) || nowUnixSeconds <= 0) {
    throw new Error("Claimant key clock is invalid");
  }
  const issuanceWindow =
    options.maybeIssuanceWindowSeconds ?? DEFAULT_ISSUANCE_WINDOW_SECONDS;
  if (!Number.isSafeInteger(issuanceWindow) || issuanceWindow <= 0 || issuanceWindow > 300) {
    throw new Error("Claimant key issuance window must be between 1 and 300 seconds");
  }
  const retentionExpiry = positiveInteger(
    nowUnixSeconds + issuanceWindow,
    "retention expiry",
  );
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  );
  const record: StoredClaimantKey = {
    keyId: crypto.randomUUID(),
    publicJwk: await crypto.subtle.exportKey("jwk", pair.publicKey),
    privateKey: pair.privateKey,
    retentionExpiry,
  };
  const store = claimantKeyStore();
  await store.put(record);
  return PreparedClaimantIdentity[claimantIdentityConstruction](record, store, now);
}

export async function restoreClaimantIdentity(
  keyId: string,
  options: ClaimantIdentityOptions = {},
): Promise<PreparedClaimantIdentity> {
  if (!validKeyId(keyId)) {
    throw new TypeError("Claimant key ID is invalid");
  }
  const store = claimantKeyStore();
  const storedValue = await store.get(keyId);
  if (storedValue === undefined) throw new Error("Claimant key is not retained");
  const maybeRecord = parseStoredClaimantKey(storedValue);
  if (!maybeRecord || maybeRecord.keyId !== keyId) {
    await store.delete(keyId);
    throw new Error("Stored Claimant key is invalid");
  }
  const now = clock(options);
  const nowUnixSeconds = now();
  if (!Number.isSafeInteger(nowUnixSeconds) || nowUnixSeconds >= maybeRecord.retentionExpiry) {
    await store.delete(keyId);
    throw new Error("Claimant key is no longer retained");
  }
  if (!(await validStoredClaimantKey(maybeRecord))) {
    await store.delete(keyId);
    throw new Error("Stored Claimant key is invalid");
  }
  return PreparedClaimantIdentity[claimantIdentityConstruction](maybeRecord, store, now);
}

function claimantKeyJson(jwk: JsonWebKey): string {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y || jwk.d) {
    throw new Error("Claimant public key is invalid");
  }
  return canonicalJson({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });
}

function parseStoredClaimantKey(value: unknown): StoredClaimantKey | undefined {
  const maybeRecord = objectRecord(value);
  if (!maybeRecord) return undefined;
  const maybePublicJwk = objectRecord(maybeRecord.publicJwk);
  if (
    typeof maybeRecord.keyId !== "string" ||
    !validKeyId(maybeRecord.keyId) ||
    !(maybeRecord.privateKey instanceof CryptoKey) ||
    typeof maybeRecord.retentionExpiry !== "number" ||
    !Number.isSafeInteger(maybeRecord.retentionExpiry) ||
    maybeRecord.retentionExpiry <= 0 ||
    !maybePublicJwk ||
    maybePublicJwk.kty !== "EC" ||
    maybePublicJwk.crv !== "P-256" ||
    typeof maybePublicJwk.x !== "string" ||
    typeof maybePublicJwk.y !== "string" ||
    maybePublicJwk.d !== undefined
  ) {
    return undefined;
  }
  const maybeBoundChallengeId = maybeRecord.maybeBoundChallengeId;
  if (
    maybeBoundChallengeId !== undefined &&
    (typeof maybeBoundChallengeId !== "string" || maybeBoundChallengeId.length === 0)
  ) {
    return undefined;
  }
  const maybeConsentBinding = parseConsentBinding(maybeRecord.maybeConsentBinding);
  if (maybeRecord.maybeConsentBinding !== undefined && !maybeConsentBinding) return undefined;
  if (
    maybeConsentBinding &&
    maybeBoundChallengeId !== maybeConsentBinding.challengeId
  ) {
    return undefined;
  }
  return {
    keyId: maybeRecord.keyId,
    publicJwk: {
      kty: maybePublicJwk.kty,
      crv: maybePublicJwk.crv,
      x: maybePublicJwk.x,
      y: maybePublicJwk.y,
    },
    privateKey: maybeRecord.privateKey,
    retentionExpiry: maybeRecord.retentionExpiry,
    ...(maybeBoundChallengeId ? { maybeBoundChallengeId } : {}),
    ...(maybeConsentBinding ? { maybeConsentBinding } : {}),
  };
}

function parseConsentBinding(
  value: unknown,
): StoredClaimantKey["maybeConsentBinding"] {
  if (value === undefined) return undefined;
  const maybeBinding = objectRecord(value);
  const maybeReceipt = objectRecord(maybeBinding?.receipt);
  if (
    !maybeBinding ||
    typeof maybeBinding.challengeId !== "string" ||
    maybeBinding.challengeId.length === 0 ||
    !maybeReceipt ||
    typeof maybeReceipt.disclosureDigestSha256 !== "string" ||
    typeof maybeReceipt.poolOfferSetSignature !== "string"
  ) {
    return undefined;
  }
  return {
    challengeId: maybeBinding.challengeId,
    receipt: {
      disclosureDigestSha256: maybeReceipt.disclosureDigestSha256,
      poolOfferSetSignature: maybeReceipt.poolOfferSetSignature,
    },
  };
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value));
}

function validKeyId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
    value,
  );
}

async function validStoredClaimantKey(record: StoredClaimantKey): Promise<boolean> {
  const algorithm = Object.fromEntries(Object.entries(record.privateKey.algorithm));
  const metadataValid =
    record.keyId.length > 0 &&
    record.privateKey.type === "private" &&
    !record.privateKey.extractable &&
    record.privateKey.algorithm.name === "ECDSA" &&
    algorithm.namedCurve === "P-256" &&
    JSON.stringify(record.privateKey.usages) === '["sign"]' &&
    Number.isSafeInteger(record.retentionExpiry) &&
    record.retentionExpiry > 0 &&
    record.publicJwk.kty === "EC" &&
    record.publicJwk.crv === "P-256" &&
    typeof record.publicJwk.x === "string" &&
    typeof record.publicJwk.y === "string" &&
    !record.publicJwk.d;
  if (!metadataValid) return false;
  try {
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      record.publicJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const proof = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      record.privateKey,
      new Uint8Array([0x42]),
    );
    return crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      proof,
      new Uint8Array([0x42]),
    );
  } catch (error) {
    if (error instanceof DOMException || error instanceof TypeError) return false;
    throw error;
  }
}

function clock(options: ClaimantIdentityOptions): () => number {
  return options.maybeClock ?? (() => Math.floor(Date.now() / 1_000));
}

const memoryRecords = new Map<string, StoredClaimantKey>();

function claimantKeyStore(): ClaimantKeyStore {
  if (typeof indexedDB === "undefined") {
    return {
      async get(keyId) {
        return memoryRecords.get(keyId);
      },
      async put(record) {
        memoryRecords.set(record.keyId, record);
      },
      async bindConsent(keyId, challengeId, receipt) {
        const maybeRecord = memoryRecords.get(keyId);
        if (!maybeRecord) throw new Error("Claimant key is not retained");
        bindConsentRecord(maybeRecord, challengeId, receipt);
        memoryRecords.set(keyId, maybeRecord);
        return maybeRecord;
      },
      async delete(keyId) {
        memoryRecords.delete(keyId);
      },
    };
  }
  return indexedDbClaimantKeyStore();
}

function indexedDbClaimantKeyStore(): ClaimantKeyStore {
  return {
    async get(keyId) {
      return idbRequest<unknown>("readonly", (store) => store.get(keyId));
    },
    async put(record) {
      await idbRequest("readwrite", (store) => store.put(record));
    },
    bindConsent: idbBindConsent,
    async delete(keyId) {
      await idbRequest("readwrite", (store) => store.delete(keyId));
    },
  };
}

function bindConsentRecord(
  record: StoredClaimantKey,
  challengeId: string,
  receipt: WorkConsentReceipt,
): void {
  if (record.maybeBoundChallengeId !== challengeId) {
    throw new Error("Work Consent does not match the bound Work Challenge");
  }
  const maybeExisting = record.maybeConsentBinding;
  if (maybeExisting) {
    if (
      maybeExisting.challengeId !== challengeId ||
      canonicalJson(maybeExisting.receipt) !== canonicalJson(receipt)
    ) {
      throw new Error("Work Consent is already bound to a different disclosure");
    }
    return;
  }
  record.maybeConsentBinding = {
    challengeId,
    receipt: structuredClone(receipt),
  };
}

async function idbBindConsent(
  keyId: string,
  challengeId: string,
  receipt: WorkConsentReceipt,
): Promise<StoredClaimantKey> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("claimant_keys", "readwrite");
    const store = transaction.objectStore("claimant_keys");
    const request = store.get(keyId);
    let maybeUpdated: StoredClaimantKey | undefined;
    let maybeBindingError: unknown;
    request.onsuccess = () => {
      const maybeRecord = parseStoredClaimantKey(request.result);
      if (!maybeRecord) {
        maybeBindingError = new Error("Stored Claimant key is invalid");
        transaction.abort();
        return;
      }
      try {
        bindConsentRecord(maybeRecord, challengeId, receipt);
        maybeUpdated = maybeRecord;
        store.put(maybeRecord);
      } catch (error) {
        maybeBindingError = error;
        transaction.abort();
      }
    };
    request.onerror = () => reject(request.error ?? new Error("Claimant key storage failed"));
    transaction.oncomplete = () => {
      database.close();
      if (!maybeUpdated) {
        reject(new Error("Work Consent storage completed without a record"));
        return;
      }
      resolve(maybeUpdated);
    };
    transaction.onabort = () => {
      database.close();
      reject(maybeBindingError ?? transaction.error ?? new Error("Work Consent storage aborted"));
    };
  });
}

async function idbRequest<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction("claimant_keys", mode);
    const request = operation(transaction.objectStore("claimant_keys"));
    request.onerror = () => reject(request.error ?? new Error("Claimant key storage failed"));
    transaction.oncomplete = () => {
      database.close();
      resolve(request.result);
    };
    transaction.onabort = () => reject(transaction.error ?? new Error("Claimant key storage aborted"));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("bwg-headless", 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("claimant_keys")) {
        request.result.createObjectStore("claimant_keys", { keyPath: "keyId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Claimant key database failed"));
  });
}
