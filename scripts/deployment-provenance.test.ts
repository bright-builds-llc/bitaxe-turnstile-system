import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { deploymentProvenance } from "./deployment-provenance";

const pins = JSON.parse(readFileSync("integration/hydra-solo/provenance.json", "utf8")) as unknown;
const facts = {
  origin: "https://gate.example.test",
  version: "0.1.0",
  commit: "0123456789abcdef0123456789abcdef01234567",
  buildTime: "2026-11-26T20:00:00Z",
  network: "mainnet" as const,
};

test("names the deployment's discovery document", () => {
  // Act
  const provenance = deploymentProvenance(facts, pins);

  // Assert
  expect(provenance.discovery).toBe("https://gate.example.test/.well-known/pow-gate-configuration");
});

test("names the source, version, commit and build", () => {
  // Act
  const provenance = deploymentProvenance(facts, pins);

  // Assert
  expect(provenance.source).toEqual({
    repository: "https://github.com/bright-builds-llc/bitaxe-turnstile-system",
    version: "0.1.0",
    commit: "0123456789abcdef0123456789abcdef01234567",
    buildTime: "2026-11-26T20:00:00Z",
    license: "MIT",
  });
});

test("names the pinned Hydra engine and the patches a mainnet build carries", () => {
  // Act
  const provenance = deploymentProvenance(facts, pins);

  // Assert
  expect(provenance.engine).toEqual({
    name: "p2poolv2 (Hydra)",
    version: "0.12.0",
    commit: "8eca024bde6c2de74620dce2f9cc7fb9a544c5c0",
    license: "AGPL-3.0-or-later",
    patches: ["p2poolv2-v0.12.0-job-admission.patch", "p2poolv2-v0.12.0-block-submission.patch"],
  });
});

test("adds the regtest patch on regtest", () => {
  // Act
  const provenance = deploymentProvenance({ ...facts, network: "regtest" }, pins);

  // Assert
  expect(provenance.engine.patches).toContain("p2poolv2-v0.12.0-regtest.patch");
});

test("names the pinned Bitcoin Core", () => {
  // Act
  const provenance = deploymentProvenance(facts, pins);

  // Assert
  expect(provenance.bitcoinCore).toEqual({ version: "31.1", license: "MIT" });
});

test("marks a build from a tree with uncommitted changes", () => {
  // Act
  const provenance = deploymentProvenance({ ...facts, commit: `${facts.commit}-dirty` }, pins);

  // Assert
  expect(provenance.source.commit).toEndWith("-dirty");
});

test("refuses a commit that isn't a full one", () => {
  // Act and assert
  expect(() => deploymentProvenance({ ...facts, commit: "abc" }, pins)).toThrow("the commit must be a full hex commit");
});

test("refuses pins that aren't the stack's provenance file", () => {
  // Act and assert
  expect(() => deploymentProvenance(facts, { schemaVersion: "other" })).toThrow("not the pinned stack's provenance");
});
