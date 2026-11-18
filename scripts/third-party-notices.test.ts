import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const NOTICES_FILE = "web/third-party-notices/bitaxe-onboarding.txt";
const ONBOARDING_ENTRIES = ["web/bitaxe-onboarding-entry.ts", "web/bitaxe-onboarding-sitting-page.ts"];

function notices(): string {
  return readFileSync(NOTICES_FILE, "utf8");
}

/** The npm packages a browser bundle of `entrypoint` carries, from Bun's per-module path comments. */
async function bundledPackages(entrypoint: string): Promise<string[]> {
  const build = await Bun.build({
    entrypoints: [entrypoint],
    target: "browser",
    format: "esm",
    define: { BWG_GATE_SOURCE_COMMIT: JSON.stringify("0".repeat(40)) },
  });
  if (!build.success) throw new AggregateError(build.logs, `bundling ${entrypoint} failed`);
  const text = (await Promise.all(build.outputs.map(output => output.text()))).join("\n");
  const packages = [...text.matchAll(/^\/\/ node_modules\/((?:@[^/\n]+\/)?[^/\n]+)\//gmu)].map(match => match[1]!);
  return [...new Set(packages)].sort();
}

test("the onboarding notices name every npm package each onboarding bundle carries", async () => {
  // Arrange
  const text = notices();

  // Act
  const unnamed: string[] = [];
  for (const entrypoint of ONBOARDING_ENTRIES) {
    for (const name of await bundledPackages(entrypoint)) {
      if (!text.includes(`== ${name} `)) unnamed.push(`${entrypoint}: ${name}`);
    }
  }

  // Assert
  expect(unnamed).toEqual([]);
});

test("the onboarding notices carry the stubs' MIT terms", () => {
  // Act
  const text = notices();

  // Assert
  expect(text).toContain("Copyright (c) 2026 Espressif Systems (Shanghai) CO LTD");
  expect(text).toContain("Permission is hereby granted");
});

test("the onboarding notices carry esptool-js's Apache licence", () => {
  // Act
  const text = notices();

  // Assert
  expect(text).toContain("Apache License");
  expect(text).toContain("Version 2.0, January 2004");
});

test("the sitting page links its notices", () => {
  // Act
  const page = readFileSync("conformance/bwg-bitaxe-onboarding-0.2/sitting.html", "utf8");

  // Assert
  expect(page).toContain('href="/dist/bitaxe-onboarding-sitting/THIRD_PARTY_NOTICES.txt"');
});
