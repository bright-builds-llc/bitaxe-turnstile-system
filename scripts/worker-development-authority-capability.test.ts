import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import capabilityInputFixture from "../conformance/bwg-worker-deployment-trust-0.2/ultra205-capability-input.json";
import { verifyWorkerControllerCapability } from "../web/worker-controller";
import { parseWorkerDeploymentTrust } from "../web/worker-deployment-trust";
import { parseWorkerSerialManifest } from "../web/worker-serial";

let parent = "";
let directory = "";

beforeEach(async () => {
  // Each test signs with a throwaway authority generated here; no existing key is read.
  parent = await mkdtemp(join(tmpdir(), "bwg-worker-capability-board-test-"));
  directory = join(parent, "authority");
  expect((await authority(["init", "--directory", directory])).exitCode).toBe(0);
});

afterEach(async () => {
  await rm(parent, { recursive: true });
});

test("signs a Gamma 601 capability when the board is named and prints that board", async () => {
  // Arrange
  const inputPath = await capabilityInput("bitaxe-gamma", "601");
  const outputPath = join(parent, "signed-capability.json");

  // Act
  const result = await signCapability(inputPath, outputPath, ["--board", "601"]);

  // Assert
  expect(result).toEqual({
    exitCode: 0,
    stderr: "",
    stdout: "worker_capability=signed board=601\n",
  });
  const trust = parseWorkerDeploymentTrust(
    JSON.parse(await readFile(join(directory, "trust.json"), "utf8")),
  );
  await expect(
    verifyWorkerControllerCapability(
      JSON.parse(await readFile(outputPath, "utf8")),
      parseWorkerSerialManifest(capabilityInputFixture.manifest),
      trust.updateAuthority.keys,
    ),
  ).resolves.toMatchObject({
    board: { model: "bitaxe-gamma", revision: "601" },
  });
});

test("signs an explicitly named Ultra 205 capability", async () => {
  // Arrange
  const inputPath = await capabilityInput("bitaxe-ultra", "205");

  // Act
  const result = await signCapability(
    inputPath,
    join(parent, "signed-capability.json"),
    ["--board", "205"],
  );

  // Assert
  expect(result.stdout).toBe("worker_capability=signed board=205\n");
});

test.each([
  ["an unknown board argument", "bitaxe-gamma", "601", ["--board", "204"]],
  ["a board argument naming another board", "bitaxe-ultra", "205", ["--board", "601"]],
  ["the default Ultra 205 against a Gamma 601 input", "bitaxe-gamma", "601", []],
  ["an input board outside the admitted set", "bitaxe-gamma", "204", ["--board", "601"]],
  ["an input pairing one board's model with another's revision", "bitaxe-ultra", "601", ["--board", "601"]],
] as const)("refuses %s without writing a capability", async (_name, model, revision, boardArguments) => {
  // Arrange
  const inputPath = await capabilityInput(model, revision);
  const outputPath = join(parent, "signed-capability.json");

  // Act
  const result = await signCapability(inputPath, outputPath, boardArguments);

  // Assert
  expect(result).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: "worker_development_authority=failed category=invalid_operation\n",
  });
  await expect(readFile(outputPath)).rejects.toThrow();
});

async function capabilityInput(model: string, revision: string): Promise<string> {
  const input = structuredClone(capabilityInputFixture);
  input.capability.board = { ...input.capability.board, model, revision };
  const path = join(parent, "capability.json");
  await writeFile(path, JSON.stringify(input), { mode: 0o644 });
  return path;
}

function signCapability(
  inputPath: string,
  outputPath: string,
  boardArguments: readonly string[],
) {
  return authority([
    "sign-capability",
    "--directory",
    directory,
    "--input",
    inputPath,
    "--output",
    outputPath,
    ...boardArguments,
  ]);
}

async function authority(args: readonly string[]) {
  const child = Bun.spawn(
    ["bun", "scripts/worker-development-authority.ts", ...args],
    { cwd: import.meta.dir + "/..", stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}
