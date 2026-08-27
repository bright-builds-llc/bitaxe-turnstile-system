import { decodeBase64Url, encodeBase64Url } from "./crypto-bytes";

const MIGRATION_KDF_ITERATIONS = 210_000;
/** Maximum plaintext settings size accepted by migration backup and onboarding. */
export const MAXIMUM_MIGRATION_SETTINGS_BYTES = 65_536;
const MAXIMUM_MIGRATION_BACKUP_BYTES = 100_000;
const MAXIMUM_CIPHERTEXT_BASE64URL_LENGTH = 87_403;

/** Encrypts bounded settings for immediate local download; callers should wipe their plaintext. */
export async function encryptMigrationBackup(
  settings: Uint8Array,
  passphrase: string,
): Promise<Uint8Array> {
  validatePassphrase(passphrase);
  if (settings.byteLength === 0 || settings.byteLength > MAXIMUM_MIGRATION_SETTINGS_BYTES) {
    throw new Error("Migration Backup settings size is invalid");
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await backupKey(passphrase, salt, "encrypt");
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, settings.slice().buffer),
  );
  return new TextEncoder().encode(
    JSON.stringify({
      profile: "bwg-migration-backup/0.1",
      kdf: {
        name: "PBKDF2-SHA256",
        iterations: MIGRATION_KDF_ITERATIONS,
        salt: encodeBase64Url(salt),
      },
      cipher: {
        name: "AES-256-GCM",
        iv: encodeBase64Url(iv),
        ciphertext: encodeBase64Url(ciphertext),
      },
    }),
  );
}

/** Decrypts one locally retained Migration Backup with user-provided material. */
export async function decryptMigrationBackup(
  encryptedBackup: Uint8Array,
  passphrase: string,
): Promise<Uint8Array> {
  validatePassphrase(passphrase);
  if (
    encryptedBackup.byteLength === 0 ||
    encryptedBackup.byteLength > MAXIMUM_MIGRATION_BACKUP_BYTES
  ) {
    throw new Error("Migration Backup is invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(encryptedBackup));
  } catch {
    throw new Error("Migration Backup is invalid");
  }
  const envelope = exactRecord(parsed, ["profile", "kdf", "cipher"]);
  const kdf = exactRecord(envelope.kdf, ["name", "iterations", "salt"]);
  const cipher = exactRecord(envelope.cipher, ["name", "iv", "ciphertext"]);
  if (
    envelope.profile !== "bwg-migration-backup/0.1" ||
    kdf.name !== "PBKDF2-SHA256" ||
    kdf.iterations !== MIGRATION_KDF_ITERATIONS ||
    cipher.name !== "AES-256-GCM" ||
    typeof kdf.salt !== "string" ||
    typeof cipher.iv !== "string" ||
    typeof cipher.ciphertext !== "string" ||
    kdf.salt.length !== 22 ||
    cipher.iv.length !== 16 ||
    cipher.ciphertext.length < 22 ||
    cipher.ciphertext.length > MAXIMUM_CIPHERTEXT_BASE64URL_LENGTH
  ) {
    throw new Error("Migration Backup is invalid");
  }
  const salt = decodeBase64Url(kdf.salt, 22, "Migration Backup is invalid");
  const iv = decodeBase64Url(cipher.iv, 16, "Migration Backup is invalid");
  const ciphertext = decodeBase64Url(
    cipher.ciphertext,
    MAXIMUM_CIPHERTEXT_BASE64URL_LENGTH,
    "Migration Backup is invalid",
  );
  if (salt.byteLength !== 16 || iv.byteLength !== 12 || ciphertext.byteLength < 16) {
    throw new Error("Migration Backup is invalid");
  }
  const key = await backupKey(passphrase, salt, "decrypt");
  let plaintext: Uint8Array;
  try {
    plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv.slice().buffer },
        key,
        ciphertext.slice().buffer,
      ),
    );
  } catch {
    throw new Error("Migration Backup authentication failed");
  }
  if (
    plaintext.byteLength === 0 ||
    plaintext.byteLength > MAXIMUM_MIGRATION_SETTINGS_BYTES
  ) {
    plaintext.fill(0);
    throw new Error("Migration Backup is invalid");
  }
  return plaintext;
}

async function backupKey(
  passphrase: string,
  salt: Uint8Array,
  usage: "encrypt" | "decrypt",
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase).buffer,
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt.slice().buffer, iterations: MIGRATION_KDF_ITERATIONS },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    [usage],
  );
}

function validatePassphrase(passphrase: string): void {
  if (passphrase.length < 12 || passphrase.length > 256) {
    throw new Error("Migration Backup passphrase is invalid");
  }
}

function exactRecord(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Migration Backup is invalid");
  }
  const value = input as Record<string, unknown>;
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    throw new Error("Migration Backup is invalid");
  }
  return value;
}
