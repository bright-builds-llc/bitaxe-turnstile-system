#!/usr/bin/env bun
/**
 * The provenance document a Gate deployment's front serves at `/provenance` (bwg-core Ticket 24):
 * its discovery URL, the source and build it runs, and the pinned engine and node with their
 * licences, read from `integration/hydra-solo/provenance.json`. Hydra is AGPL-3.0-or-later and a
 * deployment serves miners over a network, so the engine also links the exact source it runs: the
 * pinned upstream archive and each patch file at the build's commit, with the digests the stack
 * checks before building it.
 *
 * Usage: bun scripts/deployment-provenance.ts --origin URL --commit SHA[-dirty] --build-time TIME
 *          --network regtest|mainnet
 * Prints the document.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const SOURCE_REPOSITORY = "https://github.com/bright-builds-llc/bitaxe-turnstile-system";
const PINS_SCHEMA = "bwg-hydra-solo-provenance-v1";
const PATCH_DIRECTORY = "integration/hydra-solo";

export type ProvenanceFacts = {
  origin: string;
  version: string;
  commit: string;
  buildTime: string;
  network: "regtest" | "mainnet";
};

export type SourceLink = { url: string; sha256: string };
export type PatchLink = SourceLink & { file: string };

export type DeploymentProvenance = {
  discovery: string;
  source: { repository: string; version: string; commit: string; buildTime: string; license: "MIT" };
  engine: {
    name: string;
    version: string;
    commit: string;
    license: string;
    patches: string[];
    source: { upstream: SourceLink; patches: PatchLink[] };
  };
  bitcoinCore: { version: string; license: string };
};

function text(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value === "") throw new Error(`not the pinned stack's provenance: ${field}`);
  return value;
}

function section(value: unknown, field: string): Record<string, unknown> {
  const maybeSection = (value as Record<string, unknown>)[field];
  if (typeof maybeSection !== "object" || maybeSection === null) {
    throw new Error(`not the pinned stack's provenance: ${field}`);
  }
  return maybeSection as Record<string, unknown>;
}

export function deploymentProvenance(facts: ProvenanceFacts, pins: unknown): DeploymentProvenance {
  if (!/^[0-9a-f]{40}(-dirty)?$/u.test(facts.commit)) throw new Error("the commit must be a full hex commit");
  if (typeof pins !== "object" || pins === null || (pins as Record<string, unknown>).schemaVersion !== PINS_SCHEMA) {
    throw new Error("not the pinned stack's provenance");
  }
  const hydra = section(pins, "p2poolv2");
  const bitcoinCore = section(pins, "bitcoinCore");
  const patchFields = ["jobAdmissionPatch", "blockSubmissionPatch"];
  if (facts.network === "regtest") patchFields.unshift("regtestPatch");
  // A dirty build's patches can only be linked at the commit it was built on; the digests say whether they match.
  const sourceCommit = facts.commit.replace(/-dirty$/u, "");
  const patchLinks = patchFields.map((field) => {
    const file = text(hydra, field);
    return {
      file,
      url: `${SOURCE_REPOSITORY}/raw/${sourceCommit}/${PATCH_DIRECTORY}/${file}`,
      sha256: text(hydra, `${field}Sha256`),
    };
  });
  return {
    discovery: `${facts.origin}/.well-known/pow-gate-configuration`,
    source: {
      repository: SOURCE_REPOSITORY,
      version: facts.version,
      commit: facts.commit,
      buildTime: facts.buildTime,
      license: "MIT",
    },
    engine: {
      name: "p2poolv2 (Hydra)",
      version: text(hydra, "version"),
      commit: text(hydra, "commit"),
      license: text(hydra, "license"),
      patches: patchLinks.map((link) => link.file),
      source: {
        upstream: { url: text(hydra, "sourceUrl"), sha256: text(hydra, "sourceSha256") },
        patches: patchLinks,
      },
    },
    bitcoinCore: { version: text(bitcoinCore, "version"), license: text(bitcoinCore, "license") },
  };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      origin: { type: "string" },
      commit: { type: "string" },
      "build-time": { type: "string" },
      network: { type: "string" },
    },
  });
  const network = values.network;
  if (!values.origin || !values.commit || !values["build-time"] || (network !== "regtest" && network !== "mainnet")) {
    throw new Error("usage: deployment-provenance --origin URL --commit SHA --build-time TIME --network regtest|mainnet");
  }
  const repositoryRoot = resolve(import.meta.dir, "..");
  const manifest = JSON.parse(readFileSync(resolve(repositoryRoot, "Cargo.toml"), "utf8").match(/^version = ("[^"]+")/mu)?.[1] ?? '""') as string;
  const pins: unknown = JSON.parse(readFileSync(resolve(repositoryRoot, "integration/hydra-solo/provenance.json"), "utf8"));
  const provenance = deploymentProvenance(
    { origin: values.origin, version: manifest, commit: values.commit, buildTime: values["build-time"], network },
    pins,
  );
  process.stdout.write(`${JSON.stringify(provenance, null, 2)}\n`);
}
