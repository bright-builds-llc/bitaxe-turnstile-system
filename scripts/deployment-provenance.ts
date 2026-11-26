#!/usr/bin/env bun
/**
 * The provenance document a Gate deployment's front serves at `/provenance` (bwg-core Ticket 24):
 * its discovery URL, the source and build it runs, and the pinned engine and node with their
 * licences, read from `integration/hydra-solo/provenance.json`.
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

export type ProvenanceFacts = {
  origin: string;
  version: string;
  commit: string;
  buildTime: string;
  network: "regtest" | "mainnet";
};

export type DeploymentProvenance = {
  discovery: string;
  source: { repository: string; version: string; commit: string; buildTime: string; license: "MIT" };
  engine: { name: string; version: string; commit: string; license: string; patches: string[] };
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
  const patches = [text(hydra, "jobAdmissionPatch"), text(hydra, "blockSubmissionPatch")];
  if (facts.network === "regtest") patches.unshift(text(hydra, "regtestPatch"));
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
      patches,
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
