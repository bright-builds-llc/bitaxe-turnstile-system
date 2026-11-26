/**
 * Conformance Statements (Core MVP criterion 12, Ticket 25): an implementation claims one whole
 * role profile, naming the published vector files it passed by their SHA-256. The reference
 * implementation's statement also lists the checks it ran. `statementProblems` refuses a claim to
 * part of a profile, to vectors at another revision, or to a reference run with fewer checks.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type ConformanceProfile, type ConformanceProfiles, profileCommands } from "./conformance-profile";

export const REFERENCE_IMPLEMENTATION = "bwg-reference";
export const REFERENCE_SOURCE = "https://github.com/bright-builds-llc/bitaxe-turnstile-system";

export interface ConformanceStatement {
  bwg_version: string;
  role: string;
  profile: string;
  implementation: { name: string; version: string; source: string };
  /** Each claimed vector file's repository path and the SHA-256 of its bytes, in hex. */
  vectors: Record<string, string>;
  /** The reference implementation's checks, exactly as the profile runs them. */
  reference_checks?: string[][];
  passed_at: string;
}

export interface ReferenceRunFacts {
  commit: string;
  treeClean: boolean;
  vectorDigests: Record<string, string>;
  passedAt: string;
}

function profileFor(manifest: ConformanceProfiles, role: string): ConformanceProfile {
  const maybeProfile = manifest.profiles.find((profile) => profile.role === role);
  if (!maybeProfile) throw new Error(`no conformance profile for ${role}`);
  return maybeProfile;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCommandList(value: unknown): value is string[][] {
  return Array.isArray(value) && value.every((command) => Array.isArray(command) && command.every((part) => typeof part === "string"));
}

/** Reads untrusted JSON as a statement, naming the first field that is missing or of the wrong type. */
export function parseStatement(value: unknown): ConformanceStatement {
  const fail = (field: string): never => {
    throw new Error(`not a Conformance Statement: ${field}`);
  };
  if (!isRecord(value)) return fail("not an object");
  for (const field of ["bwg_version", "role", "profile", "passed_at"]) {
    if (typeof value[field] !== "string") fail(field);
  }
  const implementation = value.implementation;
  if (!isRecord(implementation) || !["name", "version", "source"].every((field) => typeof implementation[field] === "string")) {
    fail("implementation");
  }
  const vectors = value.vectors;
  if (!isRecord(vectors) || !Object.values(vectors).every((digest) => typeof digest === "string")) fail("vectors");
  if (value.reference_checks !== undefined && !isCommandList(value.reference_checks)) fail("reference_checks");
  return value as unknown as ConformanceStatement;
}

/** The statement a passing reference run makes. It names a commit, so the tree must be clean. */
export function referenceStatement(
  manifest: ConformanceProfiles,
  role: string,
  facts: ReferenceRunFacts,
): ConformanceStatement {
  if (!facts.treeClean) throw new Error("a statement names a commit, so the tree must have no uncommitted changes");
  const profile = profileFor(manifest, role);
  return {
    bwg_version: manifest.version,
    role,
    profile: profile.profile,
    implementation: { name: REFERENCE_IMPLEMENTATION, version: facts.commit, source: REFERENCE_SOURCE },
    vectors: Object.fromEntries(profile.vectors.map((path) => [path, facts.vectorDigests[path] ?? ""])),
    reference_checks: profileCommands(manifest, role),
    passed_at: facts.passedAt,
  };
}

/** Why `statement` doesn't certify its profile against the published vectors; empty when it does. */
export function statementProblems(
  manifest: ConformanceProfiles,
  statement: ConformanceStatement,
  publishedDigests: Record<string, string>,
): string[] {
  if (statement.bwg_version !== manifest.version) {
    return [`names ${statement.bwg_version}, but these profiles are ${manifest.version}`];
  }
  const maybeProfile = manifest.profiles.find((profile) => profile.role === statement.role);
  if (!maybeProfile) return [`no conformance profile for ${statement.role}`];
  if (maybeProfile.profile !== statement.profile) {
    return [`${statement.role}'s profile is ${maybeProfile.profile}, not ${statement.profile}`];
  }
  const problems: string[] = [];
  for (const path of maybeProfile.vectors) {
    const maybeClaimed = statement.vectors[path];
    if (maybeClaimed === undefined) {
      problems.push(`doesn't claim ${path}, which ${maybeProfile.profile} requires`);
    } else if (maybeClaimed !== publishedDigests[path]) {
      problems.push(`claims ${path} at another revision`);
    }
  }
  for (const path of Object.keys(statement.vectors)) {
    if (!maybeProfile.vectors.includes(path)) problems.push(`claims ${path}, which ${maybeProfile.profile} doesn't name`);
  }
  if (statement.implementation.name === REFERENCE_IMPLEMENTATION) {
    const expected = JSON.stringify(profileCommands(manifest, statement.role));
    if (JSON.stringify(statement.reference_checks ?? []) !== expected) {
      problems.push(`the reference checks differ from ${maybeProfile.profile}'s`);
    }
  }
  return problems;
}

/** The SHA-256 of each vector file's bytes, in hex, keyed by its repository path. */
export function vectorDigests(repositoryRoot: string, manifest: ConformanceProfiles): Record<string, string> {
  const paths = [...new Set(manifest.profiles.flatMap((profile) => profile.vectors))];
  return Object.fromEntries(
    paths.map((path) => [path, createHash("sha256").update(readFileSync(resolve(repositoryRoot, path))).digest("hex")]),
  );
}
