import { expect, test } from "bun:test";
import type { ConformanceProfiles } from "./conformance-profile";
import { type ConformanceStatement, parseStatement, referenceStatement, statementProblems } from "./conformance-statement";

const manifest: ConformanceProfiles = {
  version: "BWG/0.1",
  profiles: [
    {
      role: "pool-adapter",
      profile: "bwg-pool-adapter/0.1",
      protocol: [],
      bunTests: [],
      browser: false,
      rustTests: ["lifecycle_vectors"],
      vectors: ["conformance/bwg-0.1/a.json", "conformance/bwg-0.1/b.json"],
    },
  ],
  unassignedRustTests: {},
};
const digests = { "conformance/bwg-0.1/a.json": "aa", "conformance/bwg-0.1/b.json": "bb" };
const facts = {
  commit: "0123456789abcdef0123456789abcdef01234567",
  treeClean: true,
  vectorDigests: digests,
  passedAt: "2026-11-26T20:00:00.000Z",
};

function otherImplementation(vectors: Record<string, string>): ConformanceStatement {
  return {
    bwg_version: "BWG/0.1",
    role: "pool-adapter",
    profile: "bwg-pool-adapter/0.1",
    implementation: { name: "example-adapter", version: "1.0.0", source: "https://example.org/adapter" },
    vectors,
    passed_at: "2026-11-26T20:00:00.000Z",
  };
}

test("a reference statement names the profile, the commit, every vector's digest and the checks it ran", () => {
  // Act
  const statement = referenceStatement(manifest, "pool-adapter", facts);

  // Assert
  expect(statement.profile).toBe("bwg-pool-adapter/0.1");
  expect(statement.bwg_version).toBe("BWG/0.1");
  expect(statement.implementation.version).toBe(facts.commit);
  expect(statement.vectors).toEqual(digests);
  expect(statement.reference_checks).toEqual([["cargo", "test", "--all-features", "--test", "lifecycle_vectors"]]);
});

test("refuses a reference statement from a tree with uncommitted changes", () => {
  // Act and assert
  expect(() => referenceStatement(manifest, "pool-adapter", { ...facts, treeClean: false })).toThrow(
    "a statement names a commit, so the tree must have no uncommitted changes",
  );
});

test("accepts a reference statement checked against the same vectors", () => {
  // Arrange
  const statement = referenceStatement(manifest, "pool-adapter", facts);

  // Act
  const problems = statementProblems(manifest, statement, digests);

  // Assert
  expect(problems).toEqual([]);
});

test("accepts another implementation's statement that claims every vector of the profile", () => {
  // Act
  const problems = statementProblems(manifest, otherImplementation(digests), digests);

  // Assert
  expect(problems).toEqual([]);
});

test("refuses a statement that claims only part of a profile", () => {
  // Arrange
  const statement = otherImplementation({ "conformance/bwg-0.1/a.json": "aa" });

  // Act
  const problems = statementProblems(manifest, statement, digests);

  // Assert
  expect(problems).toEqual(["doesn't claim conformance/bwg-0.1/b.json, which bwg-pool-adapter/0.1 requires"]);
});

test("refuses a statement whose vector differs from the published one", () => {
  // Arrange
  const statement = otherImplementation({ ...digests, "conformance/bwg-0.1/b.json": "stale" });

  // Act
  const problems = statementProblems(manifest, statement, digests);

  // Assert
  expect(problems).toEqual(["claims conformance/bwg-0.1/b.json at another revision"]);
});

test("refuses a statement that claims a vector outside the profile", () => {
  // Arrange
  const statement = otherImplementation({ ...digests, "conformance/bwg-0.1/c.json": "cc" });

  // Act
  const problems = statementProblems(manifest, statement, { ...digests, "conformance/bwg-0.1/c.json": "cc" });

  // Assert
  expect(problems).toEqual(["claims conformance/bwg-0.1/c.json, which bwg-pool-adapter/0.1 doesn't name"]);
});

test("refuses a reference statement that ran fewer checks than its profile", () => {
  // Arrange
  const statement = { ...referenceStatement(manifest, "pool-adapter", facts), reference_checks: [] };

  // Act
  const problems = statementProblems(manifest, statement, digests);

  // Assert
  expect(problems).toEqual(["the reference checks differ from bwg-pool-adapter/0.1's"]);
});

test("refuses a statement for another protocol version", () => {
  // Arrange
  const statement = { ...otherImplementation(digests), bwg_version: "BWG/0.2" };

  // Act
  const problems = statementProblems(manifest, statement, digests);

  // Assert
  expect(problems).toEqual(["names BWG/0.2, but these profiles are BWG/0.1"]);
});

test("refuses a statement whose role and profile don't match", () => {
  // Arrange
  const statement = { ...otherImplementation(digests), profile: "bwg-client/0.1" };

  // Act
  const problems = statementProblems(manifest, statement, digests);

  // Assert
  expect(problems).toEqual(["pool-adapter's profile is bwg-pool-adapter/0.1, not bwg-client/0.1"]);
});

test("reads a statement with every field", () => {
  // Arrange
  const value: unknown = JSON.parse(JSON.stringify(otherImplementation(digests)));

  // Act
  const statement = parseStatement(value);

  // Assert
  expect(statement.implementation.name).toBe("example-adapter");
});

test("refuses a statement without its implementation", () => {
  // Arrange
  const { implementation: _, ...value } = otherImplementation(digests);

  // Act and assert
  expect(() => parseStatement(value)).toThrow("not a Conformance Statement: implementation");
});

test("refuses a statement whose vector digest isn't text", () => {
  // Arrange
  const value = { ...otherImplementation(digests), vectors: { "conformance/bwg-0.1/a.json": 1 } };

  // Act and assert
  expect(() => parseStatement(value)).toThrow("not a Conformance Statement: vectors");
});
