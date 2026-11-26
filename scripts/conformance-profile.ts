/**
 * Runs one role's BWG Conformance Profile from `conformance/profiles.json` (Core MVP criterion
 * 12): `bun run conformance <role>`. The checks run against this repository's reference
 * implementation; a role's commands run in order and the first failure ends the run.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface ConformanceProfile {
  role: string;
  profile: string;
  protocol: string[];
  bunTests: string[];
  browser: boolean;
  rustTests: string[];
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

if (import.meta.main) {
  const [maybeRole] = process.argv.slice(2);
  if (!maybeRole) {
    console.error("Usage: bun run conformance <client|gate-authority|pool-adapter|relying-service>");
    process.exit(2);
  }
  const repositoryRoot = resolve(import.meta.dir, "..");
  const manifest = loadProfiles(resolve(repositoryRoot, "conformance/profiles.json"));
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
}
