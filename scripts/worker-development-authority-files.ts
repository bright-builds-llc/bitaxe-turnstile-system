import {
  access,
  chmod,
  link,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, parse } from "node:path";

export type SequenceDocument = {
  profile: "bwg-worker-lease-sequence/0.1";
  sequences: Record<string, string>;
};

export async function writeExclusiveJson(
  path: string,
  value: unknown,
  mode: number,
): Promise<void> {
  const file = await open(path, "wx", mode);
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + "\n", "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  await chmod(path, mode);
  await syncDirectory(dirname(path));
}

export async function writeAtomicJson(
  path: string,
  value: unknown,
  mode: number,
): Promise<void> {
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeExclusiveJson(temporary, value, mode);
  await rename(temporary, path);
  await chmod(path, mode);
  await syncDirectory(dirname(path));
}

export async function tryAcquireProcessLock(
  lockPath: string,
): Promise<boolean> {
  const temporary = `${lockPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${String(process.pid)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await link(temporary, lockPath);
    await syncDirectory(dirname(lockPath));
    return true;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "EEXIST"
    ) {
      throw error;
    }
    return false;
  } finally {
    await unlink(temporary);
  }
}

export async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readJson(path: string): Promise<unknown> {
  const bytes = await readFile(path);
  if (bytes.byteLength === 0 || bytes.byteLength > 1_048_576) {
    throw new Error("input_size_invalid");
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export async function readSequenceDocument(
  path: string,
): Promise<SequenceDocument> {
  await assertProtected(path, false);
  return parseSequenceDocument(await readJson(path));
}

export function parseSequenceDocument(input: unknown): SequenceDocument {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("sequence_state_invalid");
  }
  const value = input as Record<string, unknown>;
  const sequences = value.sequences;
  if (
    Object.keys(value).length !== 2 ||
    value.profile !== "bwg-worker-lease-sequence/0.1" ||
    typeof sequences !== "object" ||
    sequences === null ||
    Array.isArray(sequences)
  ) {
    throw new Error("sequence_state_invalid");
  }
  const record = sequences as Record<string, unknown>;
  if (
    Object.entries(record).some(
      ([kid, sequence]) =>
        !/^[A-Za-z0-9_-]{1,32}$/u.test(kid) ||
        typeof sequence !== "string" ||
        !/^(0|[1-9][0-9]{0,19})$/u.test(sequence) ||
        BigInt(sequence) > 18_446_744_073_709_551_615n,
    )
  ) {
    throw new Error("sequence_state_invalid");
  }
  return {
    profile: "bwg-worker-lease-sequence/0.1",
    sequences: record as Record<string, string>,
  };
}

export async function assertProtected(
  path: string,
  directory: boolean,
): Promise<void> {
  const metadata = await stat(path);
  if (metadata.isDirectory() !== directory || (metadata.mode & 0o077) !== 0) {
    throw new Error("private_permissions_invalid");
  }
}

export async function assertOutsideGitWorktree(target: string): Promise<void> {
  let canonicalTarget: string;
  try {
    canonicalTarget = await realpath(target);
  } catch {
    canonicalTarget = join(await realpath(dirname(target)), basename(target));
  }
  let current: string;
  try {
    current = (await stat(canonicalTarget)).isDirectory()
      ? canonicalTarget
      : dirname(canonicalTarget);
  } catch {
    current = dirname(canonicalTarget);
  }
  const root = parse(current).root;
  while (current !== root) {
    try {
      await access(join(current, ".git"));
      throw new Error("authority_directory_inside_git");
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "authority_directory_inside_git"
      ) {
        throw error;
      }
    }
    current = dirname(current);
  }
}

export async function assertMissing(path: string): Promise<void> {
  try {
    await access(path);
  } catch {
    return;
  }
  throw new Error("authority_directory_exists");
}

export function requiredOption(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  if (!value || args.length !== 2) throw new Error("invalid_arguments");
  return value;
}

export function exactOptions(
  args: readonly string[],
  names: readonly string[],
): Record<string, string> {
  if (args.length !== names.length * 2) throw new Error("invalid_arguments");
  const result: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name || !names.includes(name) || !value || result[name]) {
      throw new Error("invalid_arguments");
    }
    result[name] = value;
  }
  if (Object.keys(result).length !== names.length) {
    throw new Error("invalid_arguments");
  }
  return result;
}

/** Reads a protected file or a bounded private stdin stream without persisting it. */
export async function readPrivateJsonInput(path: string): Promise<unknown> {
  if (path !== "-") {
    await assertOutsideGitWorktree(path);
    await assertProtected(path, false);
    return readJson(path);
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of Bun.stdin.stream()) {
    length += chunk.byteLength;
    if (length > 65_536) throw new Error("private_input_bound");
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("private_input_invalid");
  } finally {
    bytes.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

/** Validates private output location before a durable sequence can be consumed. */
export async function validatePrivateOutput(path: string): Promise<void> {
  if (path !== "-") await assertOutsideGitWorktree(path);
}

/** Writes one artifact to a protected file or the caller-owned stdout pipe. */
export async function writeJsonOutput(
  path: string,
  value: unknown,
  mode: number,
): Promise<void> {
  if (path === "-") {
    await Bun.write(Bun.stdout, JSON.stringify(value) + "\n");
    return;
  }
  await writeExclusiveJson(path, value, mode);
}
