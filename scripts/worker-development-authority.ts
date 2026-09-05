#!/usr/bin/env bun
import {
  createAuthority,
  parsePrivateAuthority,
  publicTrust,
  type PrivateAuthority,
  type AuthorityRole,
} from "./worker-development-authority-keys";

import { access, chmod, mkdir, readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import { signWorkerControllerCapability } from "../web/worker-deployment-trust";
import { signWorkerLeaseAuthorization } from "../web/worker-lease-authorization";
import {
  assertMissing,
  assertOutsideGitWorktree,
  assertProtected,
  exactOptions,
  parseSequenceDocument,
  readJson,
  readPrivateJsonInput,
  validatePrivateOutput,
  writeJsonOutput,
  readSequenceDocument,
  requiredOption,
  syncDirectory,
  tryAcquireProcessLock,
  writeAtomicJson,
  writeExclusiveJson,
  type SequenceDocument,
} from "./worker-development-authority-files";

type AuthorityState = {
  update: PrivateAuthority;
  lease: PrivateAuthority;
  sequence: SequenceDocument;
};

const AUTHORITY_JOURNAL_PROFILE = "bwg-worker-authority-journal/0.1";

async function main(args: readonly string[]): Promise<void> {
  const [command, ...options] = args;
  if (command === "init") {
    const directory = requiredOption(options, "--directory");
    await initialize(resolve(directory));
    console.log("development_authority=initialized");
    return;
  }
  if (command === "sign-start" || command === "sign-renew") {
    const parsed = exactOptions(options, [
      "--directory",
      "--input",
      "--output",
    ]);
    const operation = command === "sign-start" ? "start" : "renew";
    const directory = resolve(parsed["--directory"]);
    await withAuthorityLock(directory, () =>
      signLeaseAuthorization(
        operation,
        directory,
        parsed["--input"] === "-" ? "-" : resolve(parsed["--input"]),
        parsed["--output"] === "-" ? "-" : resolve(parsed["--output"]),
      ),
    );
    if (parsed["--output"] !== "-")
      console.log(`worker_lease_authorization=signed operation=${operation}`);
    return;
  }
  if (command === "public-trust") {
    const parsed = exactOptions(options, ["--directory", "--output"]);
    const directory = resolve(parsed["--directory"]);
    await withAuthorityLock(directory, async () => {
      const update = await privateAuthority(
        join(directory, "update-private.json"),
        "update_authority",
      );
      const lease = await privateAuthority(
        join(directory, "lease-private.json"),
        "work_lease_authority",
      );
      await writeJsonOutput(
        parsed["--output"] === "-" ? "-" : resolve(parsed["--output"]),
        publicTrust(update, lease),
        0o644,
      );
    });
    return;
  }
  if (command === "sign-capability") {
    const parsed = exactOptions(options, [
      "--directory",
      "--input",
      "--output",
    ]);
    const directory = resolve(parsed["--directory"]);
    await withAuthorityLock(directory, () =>
      signCapability(
        directory,
        resolve(parsed["--input"]),
        resolve(parsed["--output"]),
      ),
    );
    console.log("worker_capability=signed board=205");
    return;
  }
  if (command === "rotate") {
    const parsed = exactOptions(options, ["--directory", "--role"]);
    const role = authorityRole(parsed["--role"]);
    const directory = resolve(parsed["--directory"]);
    await withAuthorityLock(directory, () => rotateAuthority(directory, role));
    console.log(`worker_authority=rotated role=${parsed["--role"]}`);
    return;
  }
  if (command === "retire") {
    const parsed = exactOptions(options, [
      "--directory",
      "--role",
      "--kid",
      "--confirm-destructive-retirement",
    ]);
    if (parsed["--kid"] !== parsed["--confirm-destructive-retirement"]) {
      throw new Error("retirement_confirmation_mismatch");
    }
    const role = authorityRole(parsed["--role"]);
    const directory = resolve(parsed["--directory"]);
    await withAuthorityLock(directory, () =>
      retireAuthority(directory, role, parsed["--kid"]),
    );
    console.log(`worker_authority=retired role=${parsed["--role"]}`);
    return;
  }
  throw new Error("unsupported_command");
}

async function initialize(directory: string): Promise<void> {
  await assertOutsideGitWorktree(directory);
  await assertMissing(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const update = await createAuthority("update_authority");
  const lease = await createAuthority("work_lease_authority");
  await writeExclusiveJson(
    join(directory, "update-private.json"),
    update,
    0o600,
  );
  await writeExclusiveJson(join(directory, "lease-private.json"), lease, 0o600);
  await writeExclusiveJson(
    join(directory, "lease-sequence.json"),
    {
      profile: "bwg-worker-lease-sequence/0.1",
      sequences: { [lease.activeKid]: "0" },
    },
    0o600,
  );
  await writeExclusiveJson(
    join(directory, "trust.json"),
    publicTrust(update, lease),
    0o644,
  );
}

async function signLeaseAuthorization(
  operation: "start" | "renew",
  directory: string,
  inputPath: string,
  outputPath: string,
): Promise<void> {
  await validatePrivateOutput(outputPath);
  const registry = await privateAuthority(
    join(directory, "lease-private.json"),
    "work_lease_authority",
  );
  const maybeKey = registry.keys.find((key) => key.kid === registry.activeKid);
  if (!maybeKey) throw new Error("active_key_missing");
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    maybeKey,
    "Ed25519",
    false,
    ["sign"],
  );
  const request = await readPrivateJsonInput(inputPath);
  if (
    typeof request !== "object" ||
    request === null ||
    Array.isArray(request) ||
    (request as Record<string, unknown>).operation !== operation
  ) {
    throw new Error("operation_mismatch");
  }
  const sequence = await allocateSequenceLocked(directory, registry.activeKid);
  const authorization = await signWorkerLeaseAuthorization({
    input: request as Parameters<
      typeof signWorkerLeaseAuthorization
    >[0]["input"],
    sequence,
    kid: registry.activeKid,
    issuer: "development-worker-lease-authority",
    audience: "bwg-worker-controller/0.4",
    privateKey,
  });
  await writeJsonOutput(
    outputPath,
    {
      profile: "bwg-worker-lease-authorization-artifact/0.1",
      operation,
      sequence,
      authorization,
    },
    0o600,
  );
}

async function signCapability(
  directory: string,
  inputPath: string,
  outputPath: string,
): Promise<void> {
  const registry = await privateAuthority(
    join(directory, "update-private.json"),
    "update_authority",
  );
  const maybeKey = registry.keys.find((key) => key.kid === registry.activeKid);
  if (!maybeKey) throw new Error("active_key_missing");
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    maybeKey,
    "Ed25519",
    false,
    ["sign"],
  );
  const input = await readJson(inputPath);
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("capability_input_invalid");
  }
  const value = input as Record<string, unknown>;
  if (Object.keys(value).length !== 2 || !value.capability || !value.manifest) {
    throw new Error("capability_input_invalid");
  }
  const signed = await signWorkerControllerCapability({
    capability: value.capability as Parameters<
      typeof signWorkerControllerCapability
    >[0]["capability"],
    manifest: value.manifest as Parameters<
      typeof signWorkerControllerCapability
    >[0]["manifest"],
    kid: registry.activeKid,
    privateKey,
  });
  await writeExclusiveJson(outputPath, signed, 0o644);
}

async function rotateAuthority(
  directory: string,
  role: AuthorityRole,
): Promise<void> {
  const update = await privateAuthority(
    join(directory, "update-private.json"),
    "update_authority",
  );
  const lease = await privateAuthority(
    join(directory, "lease-private.json"),
    "work_lease_authority",
  );
  const rotated = await createAuthority(role);
  const target = role === "update_authority" ? update : lease;
  const next = {
    ...target,
    activeKid: rotated.activeKid,
    keys: [...target.keys, ...rotated.keys],
  };
  const sequencePath = join(directory, "lease-sequence.json");
  const sequenceState = await sequenceDocument(sequencePath);
  if (role === "work_lease_authority") {
    sequenceState.sequences[rotated.activeKid] = "0";
  }
  await commitAuthorityState(directory, {
    update: role === "update_authority" ? next : update,
    lease: role === "work_lease_authority" ? next : lease,
    sequence: sequenceState,
  });
}

async function retireAuthority(
  directory: string,
  role: AuthorityRole,
  kid: string,
): Promise<void> {
  if (!/^[A-Za-z0-9_-]{1,32}$/u.test(kid)) throw new Error("key_id_invalid");
  const update = await privateAuthority(
    join(directory, "update-private.json"),
    "update_authority",
  );
  const lease = await privateAuthority(
    join(directory, "lease-private.json"),
    "work_lease_authority",
  );
  const target = role === "update_authority" ? update : lease;
  if (target.activeKid === kid || !target.keys.some((key) => key.kid === kid)) {
    throw new Error("key_not_retirable");
  }
  const retired = {
    ...target,
    keys: target.keys.filter((key) => key.kid !== kid),
  };
  const nextUpdate = role === "update_authority" ? retired : update;
  const nextLease = role === "work_lease_authority" ? retired : lease;
  const sequenceState = await sequenceDocument(
    join(directory, "lease-sequence.json"),
  );
  if (role === "work_lease_authority") {
    delete sequenceState.sequences[kid];
  }
  await commitAuthorityState(directory, {
    update: nextUpdate,
    lease: nextLease,
    sequence: sequenceState,
  });
}

async function allocateSequenceLocked(
  directory: string,
  kid: string,
): Promise<string> {
  const path = join(directory, "lease-sequence.json");
  const value = await sequenceDocument(path);
  const record = value.sequences;
  const current = record[kid];
  if (typeof current !== "string" || !/^(0|[1-9][0-9]{0,19})$/u.test(current)) {
    throw new Error("sequence_state_invalid");
  }
  const next = BigInt(current) + 1n;
  if (next > 18_446_744_073_709_551_615n) {
    throw new Error("sequence_exhausted");
  }
  record[kid] = next.toString();
  await writeAtomicJson(path, value, 0o600);
  return next.toString();
}

async function sequenceDocument(path: string): Promise<SequenceDocument> {
  return readSequenceDocument(path);
}

async function withAuthorityLock<T>(
  directory: string,
  operation: () => Promise<T>,
): Promise<T> {
  await assertOutsideGitWorktree(directory);
  await assertProtected(directory, true);
  const lockPath = join(directory, "authority.lock");
  let acquired = false;
  for (let attempt = 0; attempt < 500 && !acquired; attempt += 1) {
    acquired = await tryAcquireProcessLock(lockPath);
    if (!acquired) {
      await clearStaleAuthorityLock(lockPath, directory);
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
  }
  if (!acquired) throw new Error("authority_lock_timeout");

  let maybeResult: T | undefined;
  let maybeOriginalError: unknown;
  try {
    await recoverAuthorityJournal(directory);
    maybeResult = await operation();
  } catch (error) {
    maybeOriginalError = error;
  }
  let maybeCleanupError: unknown;
  try {
    await unlink(lockPath);
    await syncDirectory(directory);
  } catch (error) {
    maybeCleanupError ??= error;
  }
  if (maybeOriginalError) throw maybeOriginalError;
  if (maybeCleanupError) throw maybeCleanupError;
  return maybeResult as T;
}

async function commitAuthorityState(
  directory: string,
  state: AuthorityState,
): Promise<void> {
  validateAuthorityState(state);
  const journalPath = join(directory, "authority-journal.json");
  await writeAtomicJson(
    journalPath,
    {
      profile: AUTHORITY_JOURNAL_PROFILE,
      ...state,
    },
    0o600,
  );
  maybeFail("after_journal");
  await applyAuthorityState(directory, state);
  await unlink(journalPath);
  await syncDirectory(directory);
}

async function recoverAuthorityJournal(directory: string): Promise<void> {
  const journalPath = join(directory, "authority-journal.json");
  try {
    await access(journalPath);
  } catch {
    return;
  }
  await assertProtected(journalPath, false);
  const input = await readJson(journalPath);
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("authority_journal_invalid");
  }
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).length !== 4 ||
    value.profile !== AUTHORITY_JOURNAL_PROFILE
  ) {
    throw new Error("authority_journal_invalid");
  }
  const state: AuthorityState = {
    update: parsePrivateAuthority(value.update, "update_authority"),
    lease: parsePrivateAuthority(value.lease, "work_lease_authority"),
    sequence: parseSequenceDocument(value.sequence),
  };
  validateAuthorityState(state);
  await applyAuthorityState(directory, state);
  await unlink(journalPath);
  await syncDirectory(directory);
}

function validateAuthorityState(state: AuthorityState): void {
  publicTrust(state.update, state.lease);
  const leaseKeyIds = state.lease.keys.map((key) => key.kid).sort();
  const sequenceKeyIds = Object.keys(state.sequence.sequences).sort();
  if (
    leaseKeyIds.length !== sequenceKeyIds.length ||
    leaseKeyIds.some((kid, index) => kid !== sequenceKeyIds[index])
  ) {
    throw new Error("authority_state_invalid");
  }
}

async function clearStaleAuthorityLock(
  lockPath: string,
  directory: string,
): Promise<void> {
  let ownerText: string;
  try {
    ownerText = await readFile(lockPath, "utf8");
  } catch {
    return;
  }
  if (!/^[1-9][0-9]*\n$/u.test(ownerText)) return;
  const owner = Number(ownerText.trim());
  try {
    process.kill(owner, 0);
    return;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ESRCH"
    ) {
      return;
    }
  }
  try {
    await unlink(lockPath);
    await syncDirectory(directory);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }
}

async function applyAuthorityState(
  directory: string,
  state: AuthorityState,
): Promise<void> {
  const trust = publicTrust(state.update, state.lease);
  await writeAtomicJson(join(directory, "trust.json"), trust, 0o644);
  maybeFail("after_trust");
  await writeAtomicJson(
    join(directory, "lease-sequence.json"),
    state.sequence,
    0o600,
  );
  maybeFail("after_sequence");
  await writeAtomicJson(
    join(directory, "update-private.json"),
    state.update,
    0o600,
  );
  maybeFail("after_update_private");
  await writeAtomicJson(
    join(directory, "lease-private.json"),
    state.lease,
    0o600,
  );
}

function maybeFail(step: string): void {
  if (process.env.BWG_WORKER_AUTHORITY_FAIL_AFTER === step) {
    throw new Error("injected_authority_failure");
  }
}

async function privateAuthority(
  path: string,
  role: AuthorityRole,
): Promise<PrivateAuthority> {
  await assertProtected(path, false);
  return parsePrivateAuthority(await readJson(path), role);
}

function authorityRole(input: string): AuthorityRole {
  if (input === "update") return "update_authority";
  if (input === "lease") return "work_lease_authority";
  throw new Error("authority_role_invalid");
}

await main(Bun.argv.slice(2)).catch(() => {
  console.error(
    "worker_development_authority=failed category=invalid_operation",
  );
  process.exitCode = 1;
});
