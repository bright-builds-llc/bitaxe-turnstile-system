/**
 * Runs one role's BWG Conformance Profile from `conformance/profiles.json` (Core MVP criterion
 * 12): `bun run conformance <role>`. The checks run against this repository's reference
 * implementation; a role's commands run in order and the first failure ends the run. With
 * `--statement <path>` a passing run on a clean tree writes its Conformance Statement, and
 * `--check <path>` checks any implementation's statement (`scripts/conformance-statement.ts`).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export interface ConformanceProfile {
  role: string;
  profile: string;
  protocol: string[];
  bunTests: string[];
  browser: boolean;
  rustTests: string[];
  /** The language-neutral vector files an implementation of this role must pass. */
  vectors: string[];
}

export interface ConformanceProfiles {
  version: string;
  profiles: ConformanceProfile[];
  /** Rust test targets no role claims, each with the reason. */
  unassignedRustTests: Record<string, string>;
}

export function loadProfiles(path: string): ConformanceProfiles {
  return JSON.parse(readFileSync(path, "utf8")) as ConformanceProfiles;
}

/** The commands that check `role`: its Rust targets in one cargo run, its Bun tests, then the browser check. */
export function profileCommands(manifest: ConformanceProfiles, role: string): string[][] {
  const maybeProfile = manifest.profiles.find((profile) => profile.role === role);
  if (!maybeProfile) {
    const known = manifest.profiles.map((profile) => profile.role).join(", ");
    throw new Error(`no conformance profile for ${role}; known roles: ${known}`);
  }
  const commands: string[][] = [];
  if (maybeProfile.rustTests.length > 0) {
    commands.push(["cargo", "test", "--all-features", ...maybeProfile.rustTests.flatMap((target) => ["--test", target])]);
  }
  if (maybeProfile.bunTests.length > 0) commands.push(["bun", "test", ...maybeProfile.bunTests]);
  if (maybeProfile.browser) commands.push(["bun", "run", "test:browser"]);
  return commands;
}

/** Rust test targets that neither a profile nor the unassigned list names. */
export function unassignedRustTests(manifest: ConformanceProfiles, targets: readonly string[]): string[] {
  const claimed = new Set([
    ...manifest.profiles.flatMap((profile) => profile.rustTests),
    ...Object.keys(manifest.unassignedRustTests),
  ]);
  return targets.filter((target) => !claimed.has(target));
}

function git(repositoryRoot: string, args: string[]): string {
  const run = Bun.spawnSync(["git", ...args], { cwd: repositoryRoot, stdout: "pipe", stderr: "inherit" });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return run.stdout.toString().trim();
}

async function checkStatement(repositoryRoot: string, manifest: ConformanceProfiles, path: string): Promise<void> {
  const { parseStatement, statementProblems, vectorDigests } = await import("./conformance-statement");
  const statement = parseStatement(JSON.parse(readFileSync(path, "utf8")));
  const problems = statementProblems(manifest, statement, vectorDigests(repositoryRoot, manifest));
  if (problems.length > 0) {
    for (const problem of problems) console.error(`${path}: ${problem}`);
    process.exit(1);
  }
  console.log(`${path}: certifies ${statement.implementation.name} ${statement.implementation.version} for ${statement.profile}`);
}

async function writeStatement(repositoryRoot: string, manifest: ConformanceProfiles, role: string, path: string) {
  const { referenceStatement, vectorDigests } = await import("./conformance-statement");
  const statement = referenceStatement(manifest, role, {
    commit: git(repositoryRoot, ["rev-parse", "HEAD"]),
    treeClean: git(repositoryRoot, ["status", "--porcelain"]) === "",
    vectorDigests: vectorDigests(repositoryRoot, manifest),
    passedAt: new Date().toISOString(),
  });
  writeFileSync(path, `${JSON.stringify(statement, null, 2)}\n`);
  console.log(`wrote ${path}`);
}

if (import.meta.main) {
  const usage =
    "Usage: bun run conformance <client|gate-authority|pool-adapter|relying-service> [--statement <path>]\n" +
    "       bun run conformance --check <statement.json>";
  const args = process.argv.slice(2);
  const repositoryRoot = resolve(import.meta.dir, "..");
  const manifest = loadProfiles(resolve(repositoryRoot, "conformance/profiles.json"));
  if (args[0] === "--check") {
    const maybePath = args[1];
    if (!maybePath) {
      console.error(usage);
      process.exit(2);
    }
    await checkStatement(repositoryRoot, manifest, maybePath);
    process.exit(0);
  }
  const [maybeRole, maybeFlag, maybeStatementPath] = args;
  if (!maybeRole || (maybeFlag !== undefined && (maybeFlag !== "--statement" || !maybeStatementPath))) {
    console.error(usage);
    process.exit(2);
  }
  const maybeProfile = manifest.profiles.find((profile) => profile.role === maybeRole);
  for (const command of profileCommands(manifest, maybeRole)) {
    console.log(`$ ${command.join(" ")}`);
    const run = Bun.spawnSync(command, { cwd: repositoryRoot, stdout: "inherit", stderr: "inherit" });
    if (run.exitCode !== 0) {
      console.error(`${maybeProfile?.profile ?? maybeRole}: failed at ${command.join(" ")}`);
      process.exit(run.exitCode ?? 1);
    }
  }
  console.log(`${maybeProfile?.profile ?? maybeRole} (${manifest.version}): passed`);
  if (maybeStatementPath) await writeStatement(repositoryRoot, manifest, maybeRole, maybeStatementPath);
}
