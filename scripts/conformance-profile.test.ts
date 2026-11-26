import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { loadProfiles, profileCommands, unassignedRustTests } from "./conformance-profile";

const repositoryRoot = resolve(import.meta.dir, "..");
const manifest = loadProfiles(resolve(repositoryRoot, "conformance/profiles.json"));
const rustTargets = readdirSync(resolve(repositoryRoot, "tests"))
  .filter((name) => name.endsWith(".rs"))
  .map((name) => name.slice(0, -".rs".length));
const publishedVectors = readdirSync(resolve(repositoryRoot, "conformance/bwg-0.1"))
  .filter((name) => name.endsWith(".json"))
  .map((name) => `conformance/bwg-0.1/${name}`);

/** Every source file under `path`, which may be a file or a directory. */
function sourcesUnder(path: string): string[] {
  const absolute = resolve(repositoryRoot, path);
  if (!existsSync(absolute)) return [];
  if (!statSync(absolute).isDirectory()) return [absolute];
  return readdirSync(absolute, { recursive: true, encoding: "utf8" })
    .map((name) => resolve(absolute, name))
    .filter((file) => statSync(file).isFile());
}

/** The text of every file a role's checks run: its Rust targets, its Bun tests and the browser harnesses. */
function checkSources(role: string): string {
  const profile = manifest.profiles.find((candidate) => candidate.role === role);
  if (!profile) return "";
  const paths = [
    ...profile.rustTests.flatMap((target) => [`tests/${target}.rs`, `tests/${target}`]),
    ...profile.bunTests,
    ...(profile.browser ? ["conformance/bwg-0.1"] : []),
  ];
  return paths
    .flatMap(sourcesUnder)
    .filter((file) => !file.endsWith(".json"))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
}

test("names the four roles Core MVP criterion 12 asks for, at BWG/0.1", () => {
  // Act
  const roles = manifest.profiles.map((profile) => `${profile.role} ${profile.profile}`);

  // Assert
  expect(manifest.version).toBe("BWG/0.1");
  expect(roles).toEqual([
    "client bwg-client/0.1",
    "gate-authority bwg-gate-authority/0.1",
    "pool-adapter bwg-pool-adapter/0.1",
    "relying-service bwg-relying-service/0.1",
  ]);
});

test("assigns every Rust test target to a profile or names why it has none", () => {
  // Act
  const unassigned = unassignedRustTests(manifest, rustTargets);

  // Assert
  expect(unassigned).toEqual([]);
});

test("reports a Rust test target that no profile claims", () => {
  // Act
  const unassigned = unassignedRustTests(manifest, [...rustTargets, "new_unclaimed_test"]);

  // Assert
  expect(unassigned).toEqual(["new_unclaimed_test"]);
});

test("claims every published vector file for at least one role", () => {
  // Act
  const claimed = new Set(manifest.profiles.flatMap((profile) => profile.vectors));

  // Assert
  expect(publishedVectors.filter((path) => !claimed.has(path))).toEqual([]);
});

test("names only vectors that the role's own checks read", () => {
  // Act
  const unread = manifest.profiles.flatMap((profile) => {
    const sources = checkSources(profile.role);
    return profile.vectors
      .filter((path) => !sources.includes(path.split("/").at(-1) ?? path))
      .map((path) => `${profile.role} ${path}`);
  });

  // Assert
  expect(unread).toEqual([]);
});

test("lists only Rust test targets, Bun test paths, vectors and protocol documents that exist", () => {
  // Arrange
  const paths = manifest.profiles.flatMap((profile) => [...profile.protocol, ...profile.bunTests, ...profile.vectors]);
  const targets = manifest.profiles.flatMap((profile) => profile.rustTests);

  // Act
  const missingPaths = paths.filter((path) => !existsSync(resolve(repositoryRoot, path)));
  const missingTargets = targets.filter((target) => !rustTargets.includes(target));

  // Assert
  expect(missingPaths).toEqual([]);
  expect(missingTargets).toEqual([]);
});

test("runs a role's Rust targets in one cargo invocation, then its Bun tests and browser check", () => {
  // Arrange
  const roleManifest = {
    version: "BWG/0.1",
    profiles: [
      { role: "client", profile: "bwg-client/0.1", protocol: [], bunTests: ["web"], browser: true, rustTests: [], vectors: [] },
      { role: "pool-adapter", profile: "bwg-pool-adapter/0.1", protocol: [], bunTests: [], browser: false, rustTests: ["a", "b"], vectors: [] },
    ],
    unassignedRustTests: {},
  };

  // Act
  const client = profileCommands(roleManifest, "client");
  const adapter = profileCommands(roleManifest, "pool-adapter");

  // Assert
  expect(client).toEqual([
    ["bun", "test", "web"],
    ["bun", "run", "test:browser"],
  ]);
  expect(adapter).toEqual([["cargo", "test", "--all-features", "--test", "a", "--test", "b"]]);
});

test("refuses a role the manifest doesn't name", () => {
  // Act and assert
  expect(() => profileCommands(manifest, "worker-controller")).toThrow(
    "no conformance profile for worker-controller; known roles: client, gate-authority, pool-adapter, relying-service",
  );
});
